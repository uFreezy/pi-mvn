# pi-mvn

Maven and Java tooling for the [pi coding agent](https://pi.dev). The green hammer and
the green arrow, for agents.

Running `mvn` through the agent's `bash` tool works, but a single failing `mvn verify`
prints thousands of lines and most of them are download progress, plugin banners and
stack frames. That output goes straight into the context window, and the one line the
model actually needed — `App.java:42:17 cannot find symbol` — is buried in it.

`pi-mvn` runs Maven for you and returns only the part that carries information:

```
FAILED  mvn test  (2.2s)
Tests: 2 run, 1 failed, 0 errors, 0 skipped

Test failures (1):
  AppTest.shouldFail:8  expected: <5> but was: <4>

Full log: /tmp/pi-mvn-hkMCwE/test.log
```

That is 6 lines instead of 68 for a two-test project, and the ratio only improves on
real ones. The full log is always written to disk, so nothing is lost — the model can
read it back when it genuinely needs the stack trace.

## Install

```bash
pi install npm:pi-mvn
```

Project-local instead of global:

```bash
pi install npm:pi-mvn -l
```

Try it without installing:

```bash
pi -e npm:pi-mvn
```

Requires `mvn` (or a `mvnw` wrapper in the project) and a JDK on `PATH`.

## Tools

| Tool | What it does |
|------|--------------|
| `mvn_build` | Runs any goals or phases. Returns compile errors as `file:line:column` with the javac message and its `symbol:` / `location:` detail, plus per-module status for reactor builds. |
| `mvn_test` | Runs Surefire and/or Failsafe. Returns run/failed/skipped counts and one line per failure: test name, source line, assertion message. |
| `mvn_run` | Starts the application. Auto-detects `spring-boot:run`, an exec-plugin `mainClass`, or a `public static void main` in the sources. Can run in the background so a server stays up while the agent keeps working. |
| `mvn_project` | Reactor root, runner, modules, profiles, Java target, detected main classes, Maven and JDK versions, dependency tree, effective POM. |

Everything auto-detects the reactor root by walking up from the working directory, and
prefers `./mvnw` over `mvn` when a wrapper is present.

### Building

```jsonc
{ "goals": ["compile"] }                                  // the common case
{ "goals": ["clean", "package"], "skipTests": true }
{ "goals": ["verify"], "module": "services/api" }         // adds -pl services/api -am
{ "goals": ["compile"], "profiles": ["dev"] }             // -P dev
```

`module` accepts either a directory (`services/api`) or an artifactId (`api`).

### Testing

```jsonc
{}                                                        // all unit tests
{ "filter": "AppTest#shouldAdd" }                         // one method
{ "filter": "com.example.*Test" }
{ "scope": "integration" }                                // Failsafe only
{ "scope": "all", "module": "core" }                      // Surefire + Failsafe
```

Filtered runs in a multi-module reactor pass `failIfNoSpecifiedTests=false`, so modules
that do not contain the test are skipped rather than failed.

### Running

```jsonc
{}                                                        // detect and run
{ "mainClass": "com.example.App", "appArgs": ["--port", "8080"] }
{ "background": true }                                    // returns an id, keeps running
{ "action": "logs" }                                      // tail the newest background app
{ "action": "stop" }
{ "target": "jar" }                                       // java -jar target/*.jar
{ "javaHome": "/opt/jdk-21" }                             // run under a different JDK
```

Background apps are session-scoped and are killed when the pi session ends.

## The panel

A persistent status strip in the TUI, IntelliJ's Maven tool window compressed to
the lines that earn their space. It is adaptive: one line when idle and clean,
growing only when something is running or broken.

```
                                     ─ maven  demo 1.0-SNAPSHOT · mvn · java 17  alt+m ─
                        ⠋ compile   demo compiler:compile   4s
```

```
                                     ─ maven  demo 1.0-SNAPSHOT · mvn · java 17  alt+m ─
              ✗ test  ·  2 run · 1 failed  ·  2.2s     ● app-1  up 2m14s  :8080
                                     AppTest.shouldFail:8  expected: <5> but was: <4>
```

The port comes from the running app's own startup banner (Spring Boot, Quarkus,
Micronaut and plain Netty/Tomcat lines are recognised).

### The actions menu

`alt+m` opens the menu — the equivalent of double-clicking a goal in the
IntelliJ tool window:

```
── maven  demo ─────────────────────────────────
   rerun test AppTest#shouldAdd   repeat the last invocation
   build                          mvn compile
   rebuild                        mvn clean compile
   test                           mvn test
   rerun 1 failed test            AppTest#shouldFail
   package                        mvn package -DskipTests
   verify                         mvn verify (unit + integration tests)
   run                            spring-boot:run in the background
   clean                          mvn clean
   panel align: right             cycle right / left / full
   hide panel                     bring it back with /mvn panel on
   ↑↓ navigate • enter run • esc close
────────────────────────────────────────────────
```

Results go into the transcript, so whatever you run by hand, the agent sees too.

### Hiding and moving it

```
/mvn panel          toggle
/mvn panel off      hide it
/mvn panel right    align right (default), left, or full-width
/mvn panel above    above the editor (default), or below
```

The choice is written to `~/.pi/agent/pi-mvn.json` and survives restarts. The
menu key lives there too (`"menuKey": "alt+m"`), and takes effect on the next
start.

**On placement:** pi's widget API offers `aboveEditor` and `belowEditor` only —
its TUI stacks full-width line regions, so an extension cannot claim a vertical
column down the side of the screen. `align: "right"` is the closest thing
available: the block hugs the terminal's right edge.

## The `/mvn` command

The same loop, driven by hand:

```
/mvn                       project overview
/mvn menu                  open the actions menu (same as alt+m)
/mvn build                 compile
/mvn build clean package   any goals
/mvn test                  run tests
/mvn test AppTest          run one test class
/mvn run                   run the app
/mvn run com.example.App   run a specific main class
/mvn deps                  dependency tree
/mvn logs                  tail the running background app
/mvn stop                  stop it
/mvn panel off             hide the panel
/mvn versions:display-dependency-updates    anything else goes straight to Maven
```

Results land in the transcript, so the agent sees the failure you just triggered and
can act on it without you pasting anything.

## What it does to the output

- Compile errors are deduplicated (`maven-compiler-plugin` 3.14+ prints each one twice)
  and reported relative to the reactor root.
- Both `File.java:[12,34] message` and `File.java:12: error: message` forms are parsed,
  so a raw `javac` or `kotlinc` error is understood as well.
- Boilerplate is dropped: `[Help 1]`, "re-run Maven with the -e switch", "Please refer
  to .../surefire-reports", the `<<< FAILURE!` banners, separator rules.
- `Failed to execute goal ...: Compilation failure` is suppressed when the individual
  errors are already listed, and kept when they are not.
- Maven runs under `-B --no-transfer-progress` with an English locale pinned via
  `MAVEN_OPTS`, so compiler messages stay parseable on non-English systems.

## Development

```bash
npm install
npm test        # parser and panel unit tests, no Maven needed
npm run smoke   # generates a Maven project and drives all four tools for real
npm run typecheck
```

`npm run smoke` needs a JDK, `mvn`, and network access for the first dependency
download. It is the check that catches format drift when a new Maven or Surefire
version changes its output.

## License

MIT
