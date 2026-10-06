# android-mcp-toolkit

An MCP server that gives AI coding agents (Claude Code, Cursor, Copilot, etc.) **clean, low-noise access to an Android project**: Gradle builds, logcat, and a connected device.

The problem it solves: raw `./gradlew` output, `adb logcat` and screenshots burn thousands of tokens on noise. These tools return only what an agent needs to act.

## Tools

### 1. Gradle output filter
| Tool | What it does |
|---|---|
| `gradle_build` | Runs `./gradlew` and returns the outcome, failed tasks, **de-duplicated errors as `file:line:col - message`** (Kotlin, Java, resources, test failures), and a short warning summary grouped with counts. Optionally saves the full log to a file. |

Example result:

```
BUILD FAILED in 14s
Failed tasks: :app:compileDebugKotlin

Errors (3):
1. [kotlin] app/src/main/java/com/acme/ui/Home.kt:42:17 - Unresolved reference: fooBar
2. [kotlin] app/src/main/java/com/acme/data/Repo.kt:10:5 - Type mismatch: ...
3. [java] app/src/main/java/com/acme/Legacy.java:7 - cannot find symbol
     > Foo f = new Foo();
Warnings: 5 total, 4 unique: ...
```

### 2. Logcat for agents
| Tool | What it does |
|---|---|
| `logcat` | Filters to one app (by package, resolved to its PID), collapses repeated lines (`x4`), shortens stack traces, and **pulls crashes and ANRs out first** with exception, root cause and app-owned frames. Pass `mappingFile` to deobfuscate R8/ProGuard traces. |
| `logcat_clear` | Clears the buffer before reproducing a bug. |

### 3. ADB / device control
| Tool | What it does |
|---|---|
| `android_devices` | List devices and emulators |
| `android_install` | Install an APK (replace + grant permissions) |
| `android_launch` | Launch, stop, restart or clear data for an app |
| `ui_dump` | **Screen as compact text**: one line per meaningful element with label, id, flags and tap coordinates. Much cheaper than screenshots |
| `android_tap`, `android_swipe`, `android_type` | Interact with the device |
| `android_screenshot` | Screenshot as an image, for when visuals matter |
| `android_current_screen` | Which activity has focus |

Example `ui_dump` output:

```
app: com.acme.app
1. TextView "Sign in" #title @(540,260)
2. EditText #email [click,focused] @(540,460)
3. Button "Log in" #login_btn [click] @(540,660)
```

An agent loop is then: `ui_dump` -> `android_tap` on the coordinates -> `ui_dump` again.

## Setup

Requires Node 18+ and Android platform-tools (`adb`) for the device tools.

```bash
git clone <this repo> && cd android-mcp-toolkit
npm install
```

**Claude Code**

```bash
claude mcp add android -- node /absolute/path/to/android-mcp-toolkit/src/server.js
```

**Cursor / other MCP clients** (`mcp.json`):

```json
{
  "mcpServers": {
    "android": {
      "command": "node",
      "args": ["/absolute/path/to/android-mcp-toolkit/src/server.js"],
      "env": { "ANDROID_HOME": "/path/to/Android/sdk" }
    }
  }
}
```

### Environment variables
| Variable | Purpose |
|---|---|
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | Used to find `adb` and `retrace` |
| `ADB_PATH` | Explicit path to `adb` |
| `RETRACE_PATH` | Explicit path to R8 `retrace` (cmdline-tools) |

## Suggested agent instructions

Add to your project's `CLAUDE.md` / `AGENTS.md`:

```
- Build with the gradle_build tool, never raw ./gradlew in a shell.
- To debug a crash: logcat_clear, reproduce, then logcat with appPackage.
- To inspect the UI: ui_dump first; screenshot only if layout or colour matters.
```

## Development

```bash
npm test
```

Parsers (`parseGradleOutput`, `condenseLogcat`, `compactUiHierarchy`) are pure functions covered by fixtures in `test/fixtures/`. Add a fixture when you hit output the filters mishandle.

## Known limitations

- Verified with fixtures and a fake Gradle wrapper; not yet exercised against every AGP/Kotlin version. Error formats differ slightly between versions, so expect to add patterns.
- `ui_dump` uses `uiautomator`, which cannot see secure windows (e.g. `FLAG_SECURE`) and may miss custom-drawn Compose content that has no semantics. Add `Modifier.semantics` / `testTag` to make elements visible.
- Retrace needs Android cmdline-tools installed.

## Roadmap

- Compose preview/screenshot loop (Paparazzi / Roborazzi)
- BLE / Wi-Fi Direct debugger (parse btsnoop HCI logs)
- `gradle_build` incremental mode with `--continuous`
