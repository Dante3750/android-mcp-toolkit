---
name: android-dev-loop
description: Efficient build-fix-verify loop for Android projects using the android MCP tools. Use when building, testing, debugging crashes or checking UI in an Android/Gradle project.
---
# Android dev loop

Use the MCP tools instead of shell `gradlew`/`adb logcat`; they return compact, filtered output.

1. **Orient (cheap):** `gradle_modules` for the module list. Use `gradle_tasks` with a `filter` only if you need a task name.
2. **Build:** `gradle_build` with `assembleDebug`. Fix errors from the `file:line` plus snippet; heed "Likely cause" hints (version mismatches, JDK, SDK, repositories, memory, R8).
3. **Test:** `gradle_test` with `module` and `filter` for the code you changed; it lists failures with assertion message and `file:line`. Run the full module before finishing.
4. **Quality:** `lint_summary` (`run: true`) for ranked lint issues; `gradle_deps_conflicts` for duplicate-class or version problems.
5. **Run:** `android_install` -> `logcat_clear` -> `android_launch`.
6. **Crash?** `logcat` with `appPackage`, `minLevel: W`, `sinceMs`; read root cause and app frames, fix, repeat from 2.
7. **UI:** `ui_dump` -> `android_tap` / `android_type` -> `ui_dump` again. `android_screenshot` only for visual questions.

Rules: never print full logs; keep `lines` small; re-read output markers like "(truncated N more)" and narrow with filters instead of raising limits.
