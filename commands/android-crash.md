---
description: Diagnose the latest crash or ANR of the app from logcat
argument-hint: "<applicationId>"
---
Diagnose the latest crash of the Android app `$ARGUMENTS` (ask for the application id only if it cannot be found in `app/build.gradle(.kts)`).

1. Call `logcat` with `appPackage`, `minLevel` `W`, `sinceMs` 120000 and `lines` 60.
2. Read the CRASH block: exception, root cause, and the app frames. Open the top app frame's file at that line.
3. Explain the cause in 2-3 sentences and propose a minimal fix; apply it if it is clearly correct.
4. If it was R8-obfuscated, retry with `mappingFile` pointing at `app/build/outputs/mapping/<variant>/mapping.txt`.
5. Rebuild with `gradle_build`, reinstall (`android_install`), `logcat_clear`, `android_launch`, and confirm the crash is gone with `logcat`.
