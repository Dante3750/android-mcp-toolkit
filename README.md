# android-mcp-toolkit

An MCP server that gives AI coding agents (Claude Code, Cursor, VS Code, Windsurf, ...) **clean, low-noise access to an Android project**: Gradle builds, unit tests, lint, logcat and a connected device.

Raw `./gradlew` output, `adb logcat` and screenshots burn thousands of tokens on noise. These tools return only what an agent needs to act, with hard output caps and an explicit `(truncated N more)` marker.


## Install: one command, any agent

```bash
npx -y github:Dante3750/android-mcp-toolkit setup
```

It finds the AI agents on your machine (Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, OpenAI Codex CLI, opencode) and adds this server to each one at user level, so it works in every Android project. Other servers in your config are never touched, and existing files get a `.bak` backup. Preview first with `setup --dry-run`, or target one agent with `setup --agent=cursor`. Restart your agent afterwards.

Check your machine (node, adb, devices, gradlew, java): `npx -y github:Dante3750/android-mcp-toolkit doctor`

## Quick start (one-liners)

**Claude Code**

```bash
claude mcp add android -- npx -y github:Dante3750/android-mcp-toolkit
```

**Cursor** (`.cursor/mcp.json`) - also valid for Windsurf (`mcpServers` key):

```json
{ "mcpServers": { "android": { "command": "npx", "args": ["-y", "github:Dante3750/android-mcp-toolkit"] } } }
```

**Check your setup** (node, adb, devices, gradlew, java, with fix hints):

```bash
npx -y github:Dante3750/android-mcp-toolkit doctor
```

Other options:

```bash
npx -y github:Dante3750/android-mcp-toolkit init           # detect editors and print the config
npx -y github:Dante3750/android-mcp-toolkit init --write   # merge it in (never overwrites other servers; writes a .bak)
```

`init` knows Claude Code (`.mcp.json`), Cursor (`.cursor/mcp.json`, or `~/.cursor/mcp.json` with `--global`), VS Code (`.vscode/mcp.json`) and Windsurf (`~/.codeium/windsurf/mcp_config.json`). Use `--client=<name>` to pick one and `--force` to replace an existing, different `android` entry. Files that are not plain JSON (e.g. VS Code files with comments) are never touched; the snippet is printed instead.

### Claude Code plugin (tools + slash commands + skill)

```
/plugin marketplace add Dante3750/android-mcp-toolkit
/plugin install android-mcp-toolkit@android-toolkit
```

Adds the MCP server (launched with `npx`, so no build step) plus `/android-build`, `/android-crash`, `/android-ui-check` and an `android-dev-loop` skill that teaches the efficient loop.

## Tools

Descriptions are deliberately short (tool descriptions cost tokens on every request). Every tool carries MCP `readOnlyHint` / `destructiveHint` annotations.

### Gradle
| Tool | What it does |
|---|---|
| `gradle_build` | Runs `./gradlew`; returns outcome, failed tasks, de-duplicated errors as `file:line:col - message` **with 2 lines of source context**, a one-line **likely cause** for common failures, and a warning summary. |
| `gradle_test` | Runs a module's unit tests (optional `--tests` filter) and returns pass/fail/skip counts plus each failure with assertion message and `file:line`, parsed from `build/test-results/**/TEST-*.xml` (only files from this run). |
| `gradle_modules` | Cheap overview from `settings.gradle(.kts)`: modules and type (app / library / jvm). Does not start Gradle. |
| `gradle_tasks` | Task list from `gradlew tasks --all`, cached until build files change; `filter` narrows it. |
| `lint_summary` | Ranks Android Lint issues from `lint-results*.xml` (severity, then priority, grouped by id with counts). `run: true` runs `lintDebug` first. |
| `gradle_deps_conflicts` | Runs the dependency report for one configuration and lists only modules whose version was changed by resolution, flags major jumps and unresolved dependencies. |

Root-cause hints in `gradle_build` cover: AGP/Kotlin/KSP mismatch, JDK version, missing SDK/licences, duplicate classes, network-vs-missing-repository for "Could not resolve", out-of-memory (with a `gradle.properties` tip) and R8 missing rules.

Example `gradle_build` result:

```
BUILD FAILED in 14s
Failed tasks: :app:compileDebugKotlin

Errors (2):
1. [kotlin] app/src/main/java/com/acme/ui/Home.kt:42:17 - Unresolved reference: fooBar
      40 |     val items = repo.items()
      41 |     items.forEach {
    > 42 |         fooBar(it)
      43 |     }
      44 | }

Likely cause:
- Out of memory: add to gradle.properties: org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g ...
```

### Logcat
| Tool | What it does |
|---|---|
| `logcat` | Filters to one app (package -> PID), collapses repeats (`x4`), shortens stacks, and **pulls crashes and ANRs out first** with exception, root cause and app frames. Options: `minLevel`, `tag` / `tags`, `lines` (max shown, default 80), `sinceMs` (only the last N ms, by device clock), `mappingFile` (R8 retrace), `clearAfter`. |
| `logcat_clear` | Clears the buffer before reproducing a bug. |

### Device
| Tool | What it does |
|---|---|
| `android_devices` | List devices and emulators |
| `android_install` | Install an APK (replace + grant permissions) |
| `android_launch` | Launch, stop, restart or clear data |
| `ui_dump` | **Screen as compact text**: label, id, flags and tap coordinates per element. Much cheaper than screenshots |
| `android_tap`, `android_swipe`, `android_type` | Interact |
| `android_screenshot` | Image, for when visuals matter |
| `android_current_screen` | Which activity has focus |

```
app: com.acme.app
1. TextView "Sign in" #title @(540,260)
2. EditText #email [click,focused] @(540,460)
3. Button "Log in" #login_btn [click] @(540,660)
```

Typical loop: `gradle_build` -> fix -> `gradle_test` -> `android_install` -> `logcat_clear` -> `android_launch` -> `logcat` (crash?) -> `ui_dump` -> `android_tap` -> `ui_dump`.

## Requirements and configuration

Node 18+. `adb` is only needed for device tools; Gradle tools need a `gradlew` in the project (searched upwards from `projectDir`) and a working JDK.

| Variable | Purpose |
|---|---|
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | Used to find `adb` and `retrace` |
| `ADB_PATH` | Explicit path to `adb` |
| `RETRACE_PATH` | Explicit path to R8 `retrace` (cmdline-tools) |

Pin a version in your config for reproducibility: `github:Dante3750/android-mcp-toolkit#v0.2.0` (once tagged).

## Suggested agent instructions

Add to `CLAUDE.md` / `AGENTS.md` (the plugin's skill does this for you):

```
- Build with gradle_build and test with gradle_test, never raw ./gradlew in a shell.
- To debug a crash: logcat_clear, reproduce, then logcat with appPackage and sinceMs.
- To inspect the UI: ui_dump first; screenshot only if layout or colour matters.
```

## Honest limits

- **Tested on fixtures only.** The suite uses hand-written, realistic Gradle / JUnit XML / lint XML / dependency-tree / logcat samples and fake `gradlew`/`adb` scripts, driven end to end through the MCP SDK client. It has **not** been run against a large range of real AGP / Kotlin / Gradle versions or real devices. Gradle output differs between versions: **please open an issue with the raw output** when something is mis-parsed.
- Root-cause hints are pattern matches on known messages; they can miss, and are a starting point, not a diagnosis.
- `gradle_test` targets JVM unit tests (`testDebugUnitTest` by default). Instrumented test results (`connectedDebugAndroidTest`) are not parsed yet. Test-result and lint files are read from the standard `<module>/build/...` locations; custom report directories are not found.
- `gradle_deps_conflicts` reads the text report; BOM-managed versions without a declared version are not shown as conflicts.
- `gradle_modules` uses a text parser, so settings scripts that compute includes programmatically are not fully resolved.
- `sinceMs` uses the device clock (`date`), falling back to the newest log line.
- `ui_dump` uses `uiautomator`, which cannot see secure windows (`FLAG_SECURE`) and may miss Compose content without semantics (add `Modifier.semantics` / `testTag`).
- R8 retrace needs Android cmdline-tools.

## Development

```bash
npm install
npm test        # node --test, includes an end-to-end MCP client test
node src/cli.js doctor
```

Parsers are pure functions covered by fixtures in `test/fixtures/`. Add a fixture when you hit output the filters mishandle.

## Roadmap

- Instrumented test result parsing
- Compose preview/screenshot loop (Paparazzi / Roborazzi)
- BLE / Wi-Fi Direct debugger (parse btsnoop HCI logs)

MIT licensed.
