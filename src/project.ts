/**
 * Maven project detection: reactor root, runner, modules, profiles, main classes.
 *
 * Everything here is filesystem + regex only. No Maven process is spawned, so
 * `mvn_project overview` answers instantly instead of paying the ~2s JVM startup
 * that `help:evaluate` would cost.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

export interface MavenModule {
	/** artifactId, or the directory name when the pom has none of its own */
	name: string;
	/** Path relative to the reactor root. Empty string for the root module. */
	path: string;
}

export interface MainClassCandidate {
	fqn: string;
	file: string;
	module: string;
}

export interface MavenProject {
	root: string;
	/** Command to invoke, already resolved: absolute wrapper path or "mvn". */
	runner: string;
	/** Short label for display, e.g. "./mvnw". */
	runnerLabel: string;
	artifactId?: string;
	packaging: string;
	javaTarget?: string;
	profiles: string[];
	modules: MavenModule[];
	springBoot: boolean;
	/** mainClass declared in a pom (exec plugin, jar manifest, or spring-boot start-class). */
	declaredMainClass?: string;
}

const SKIP_DIRS = new Set([
	"target",
	"node_modules",
	".git",
	".idea",
	".mvn",
	".settings",
	"src",
	"bin",
	"out",
	"build",
	".gradle",
]);

/** Strip XML comments so commented-out plugins and modules do not register as real. */
function stripComments(xml: string): string {
	return xml.replace(/<!--[\s\S]*?-->/g, "");
}

/** Remove the <parent> block so "first artifactId" means this pom's own artifactId. */
function stripParent(xml: string): string {
	return xml.replace(/<parent>[\s\S]*?<\/parent>/, "");
}

function tag(xml: string, name: string): string | undefined {
	const match = xml.match(new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`));
	return match?.[1];
}

/**
 * Walk up from `cwd` to the topmost pom.xml in an unbroken chain of directories.
 *
 * ponytail: contiguous-chain heuristic, not a <modules> cross-check. It is what
 * mvn itself effectively assumes and is wrong only if an unrelated pom.xml sits
 * directly above your project. Pass an explicit module if that ever bites.
 */
export function findProjectRoot(cwd: string): string | undefined {
	let dir = cwd;
	let root: string | undefined;
	for (;;) {
		if (existsSync(join(dir, "pom.xml"))) {
			root = dir;
		} else if (root) {
			break; // chain ended above the reactor root
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return root;
}

function resolveRunner(root: string): { runner: string; runnerLabel: string } {
	const wrapper = process.platform === "win32" ? "mvnw.cmd" : "mvnw";
	const path = join(root, wrapper);
	if (existsSync(path)) return { runner: path, runnerLabel: `./${wrapper}` };
	return { runner: "mvn", runnerLabel: "mvn" };
}

/** Collect every directory under `root` that holds a pom.xml. */
function findModuleDirs(root: string, maxDepth = 4): string[] {
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (existsSync(join(dir, "pom.xml"))) found.push(dir);
		if (depth >= maxDepth) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
			const child = join(dir, entry);
			try {
				if (!statSync(child).isDirectory()) continue;
			} catch {
				continue;
			}
			walk(child, depth + 1);
		}
	};
	walk(root, 0);
	return found;
}

function readPom(dir: string): string {
	try {
		return stripComments(readFileSync(join(dir, "pom.xml"), "utf8"));
	} catch {
		return "";
	}
}

export function loadProject(cwd: string): MavenProject | undefined {
	const found = findProjectRoot(cwd);
	if (!found) return undefined;
	// Maven prints canonical paths in its error lines. Canonicalizing here is what
	// lets those be reported relative to the root (macOS /var -> /private/var, and
	// any symlinked checkout).
	const root = realpathSync(found);

	const rootPom = readPom(root);
	const ownPom = stripParent(rootPom);

	const profiles = [...rootPom.matchAll(/<profile>[\s\S]*?<id>\s*([^<]+?)\s*<\/id>/g)].map((m) => m[1]);

	const modules: MavenModule[] = findModuleDirs(root).map((dir) => {
		const path = relative(root, dir);
		const pom = stripParent(readPom(dir));
		return { name: tag(pom, "artifactId") ?? basename(dir), path };
	});

	return {
		root,
		...resolveRunner(root),
		artifactId: tag(ownPom, "artifactId"),
		packaging: tag(ownPom, "packaging") ?? "jar",
		javaTarget:
			tag(rootPom, "maven.compiler.release") ??
			tag(rootPom, "maven.compiler.target") ??
			tag(rootPom, "java.version") ??
			tag(rootPom, "maven.compiler.source"),
		profiles: [...new Set(profiles)],
		modules,
		springBoot: /spring-boot-maven-plugin/.test(rootPom) || modules.some((m) => /spring-boot-maven-plugin/.test(readPom(join(root, m.path)))),
		declaredMainClass: tag(rootPom, "mainClass") ?? tag(rootPom, "start-class"),
	};
}

/**
 * Find `public static void main` across a module's Java sources.
 *
 * ponytail: regex over src/main/java, no parser. Misses main methods in Kotlin,
 * Groovy, or generated sources; pass mainClass explicitly for those.
 */
export function findMainClasses(project: MavenProject, module?: string, limit = 25): MainClassCandidate[] {
	const searchRoots = module
		? [join(project.root, module)]
		: project.modules.map((m) => join(project.root, m.path));

	const candidates: MainClassCandidate[] = [];
	const seen = new Set<string>();

	for (const moduleRoot of searchRoots) {
		const sourceRoot = join(moduleRoot, "src", "main", "java");
		if (!existsSync(sourceRoot)) continue;

		const walk = (dir: string) => {
			if (candidates.length >= limit) return;
			let entries: string[];
			try {
				entries = readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
			} catch {
				return;
			}
			for (const entry of entries) {
				if (candidates.length >= limit) return;
				if (entry.endsWith("/")) {
					walk(join(dir, entry.slice(0, -1)));
					continue;
				}
				if (!entry.endsWith(".java")) continue;
				const file = join(dir, entry);
				let source: string;
				try {
					source = readFileSync(file, "utf8");
				} catch {
					continue;
				}
				if (!/\bstatic\s+(?:final\s+)?void\s+main\s*\(/.test(source)) continue;
				const pkg = source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
				const fqn = pkg ? `${pkg}.${basename(entry, ".java")}` : basename(entry, ".java");
				if (seen.has(fqn)) continue;
				seen.add(fqn);
				candidates.push({ fqn, file: relative(project.root, file), module: relative(project.root, moduleRoot) });
			}
		};
		walk(sourceRoot);
	}

	return candidates;
}

/** Newest built jar in a module's target/, skipping sources/javadoc/original artifacts. */
export function findJar(project: MavenProject, module?: string): string | undefined {
	const targetDir = join(project.root, module ?? "", "target");
	let entries: string[];
	try {
		entries = readdirSync(targetDir);
	} catch {
		return undefined;
	}
	const jars = entries
		.filter((f) => f.endsWith(".jar") && !/-(sources|javadoc|tests)\.jar$/.test(f) && !f.startsWith("original-"))
		.map((f) => join(targetDir, f))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return jars[0];
}
