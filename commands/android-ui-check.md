---
description: Launch the app on a device and verify a screen or flow via text UI dumps
argument-hint: "<applicationId> [what to verify]"
---
Verify `$ARGUMENTS` on the connected device.

1. `android_devices` to confirm a device; `android_launch` the app (use `restart` for a clean start).
2. `ui_dump` (use `interactiveOnly` when navigating) and check the expected texts/ids are present. Prefer this over screenshots.
3. To navigate: `android_tap` on the `@(x,y)` from the dump, then `ui_dump` again after every action. Use `android_type` for input.
4. Only call `android_screenshot` if the question is visual (colors, overlap, clipped text).
5. Finish with `logcat` (`minLevel` `W`, `sinceMs` 60000) to catch silent errors. Report PASS/FAIL per checked item.
