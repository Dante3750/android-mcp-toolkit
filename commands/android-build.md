---
description: Build the Android app, fix compile errors, repeat until green
argument-hint: "[gradle task, default assembleDebug]"
---
Build the Android project in the current directory with the `gradle_build` tool (task: `$ARGUMENTS`, or `assembleDebug` if empty).

1. If the build fails, read the listed `file:line` errors and code snippets, apply the fix, and rebuild. Follow the "Likely cause" hint if one is given.
2. Never paste raw Gradle output; use `gradle_build` only. If errors are not recognised, rerun with `saveFullLogTo` and inspect the file selectively.
3. Stop after 5 failed attempts and report what is blocking you.
4. When green, report the outcome in one line.
