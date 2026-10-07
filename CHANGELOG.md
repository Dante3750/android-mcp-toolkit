# Changelog

## 0.2.0

### Added
- One-line install: `npx -y github:Dante3750/android-mcp-toolkit` starts the server. New bin `src/cli.js` with subcommands `init` (detect Claude Code / Cursor / VS Code / Windsurf, print or `--write` a safe merge), `doctor`, `--version`, `--help`.
- Claude Code plugin and marketplace in the same repo (`.claude-plugin/`, `.mcp.json`), slash commands `/android-build`, `/android-crash`, `/android-ui-check`, and the `android-dev-loop` skill.
- New tools: `gradle_test`, `gradle_modules`, `gradle_tasks` (cached), `lint_summary`, `gradle_deps_conflicts`.
- `gradle_build`: source snippets (2 lines around each error line) and one-line root-cause hints (Kotlin/KSP/AGP mismatch, JDK, missing SDK, duplicate classes, network vs missing repository, out of memory, R8 missing rules).
- `logcat`: `sinceMs`, `lines` and `tag` options.
- MCP annotations (`readOnlyHint`, `destructiveHint`, ...) on every tool.
- GitHub Actions CI (Node 18/20/22) and an end-to-end MCP client test.

### Changed
- Tool descriptions shortened to save tokens.
- All outputs are size-capped and end with `(truncated N more)` when cut.
- `logcat` hard-caps the number of lines shown.

### Fixed
- `logcat`: when warnings/errors alone filled `maxLines`, low-priority lines were all kept instead of dropped (`slice(-0)`).

## 0.1.0
- Initial release: `gradle_build`, `logcat`, `logcat_clear`, device and UI tools.
