#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runGradle, formatGradleResult } from './gradle.js';
import { readLogcat } from './logcat.js';
import * as A from './adb.js';

const server = new McpServer({ name: 'android-mcp-toolkit', version: '0.1.0' });

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message || e) }] });
const wrap = (fn) => async (args) => { try { return await fn(args); } catch (e) { return fail(e); } };

const serial = z.string().optional().describe('Device serial from android_devices. Optional when only one device is attached.');

// ---------------------------------------------------------------- 1. Gradle
server.registerTool(
  'gradle_build',
  {
    title: 'Run Gradle (filtered output)',
    description:
      'Runs ./gradlew and returns a compact result: build outcome, failed tasks, de-duplicated compiler errors as file:line - message, and a short warning summary. ' +
      'Use this instead of running gradlew in a shell: it avoids thousands of lines of log noise. Typical tasks: assembleDebug, testDebugUnitTest, lintDebug, connectedDebugAndroidTest.',
    inputSchema: {
      projectDir: z.string().describe('Absolute path to the Android project (gradlew is searched upwards from here)'),
      tasks: z.array(z.string()).min(1).describe('Gradle tasks, e.g. ["assembleDebug"] or [":app:testDebugUnitTest"]'),
      extraArgs: z.array(z.string()).optional().describe('Extra Gradle args, e.g. ["--tests", "com.foo.BarTest", "--offline"]'),
      includeWarnings: z.boolean().optional().describe('Include the warning summary (default true)'),
      maxErrors: z.number().int().min(1).max(100).optional().describe('Max errors to list (default 20)'),
      saveFullLogTo: z.string().optional().describe('If set, the full raw Gradle output is written to this file for deeper inspection'),
    },
  },
  wrap(async ({ projectDir, tasks, extraArgs, includeWarnings, maxErrors, saveFullLogTo }) => {
    const { parsed, exitCode, rawLength, raw } = await runGradle({ projectDir, tasks, extraArgs });
    let out = formatGradleResult(parsed, { includeWarnings: includeWarnings ?? true, maxErrors: maxErrors ?? 20 });
    if (saveFullLogTo) {
      await writeFile(saveFullLogTo, raw);
      out += `\n\n(full log, ${rawLength} chars, saved to ${saveFullLogTo})`;
    } else if (parsed.outcome === 'FAILED' && parsed.errorCount === 0) {
      // Nothing parseable: give the tail so the agent is never left blind
      const tail = raw.split(/\r?\n/).filter(Boolean).slice(-25).join('\n');
      out += `\n\nNo structured errors recognised. Last lines of output:\n${tail}`;
    }
    return { isError: exitCode !== 0, content: [{ type: 'text', text: out }] };
  })
);

// ---------------------------------------------------------------- 2. Logcat
server.registerTool(
  'logcat',
  {
    title: 'Read logcat (condensed)',
    description:
      'Reads the device log and returns it condensed for an agent: filtered to one app by package (via its PID), repeated lines collapsed (xN), stack traces shortened, ' +
      'and crashes/ANRs pulled out with exception, root cause and the app-owned frames first. Pass mappingFile to deobfuscate R8/ProGuard traces (needs Android cmdline-tools retrace).',
    inputSchema: {
      appPackage: z.string().optional().describe('Application id, e.g. com.example.app. Strongly recommended.'),
      minLevel: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).optional().describe('Minimum level (default I)'),
      tags: z.array(z.string()).optional().describe('Only these tags'),
      maxLines: z.number().int().min(10).max(500).optional().describe('Max log lines shown (default 80)'),
      mappingFile: z.string().optional().describe('Path to R8 mapping.txt to retrace crashes'),
      clearAfter: z.boolean().optional().describe('Clear the log buffer after reading (useful before reproducing a bug)'),
      serial,
    },
  },
  wrap(async ({ appPackage, minLevel, tags, maxLines, mappingFile, clearAfter, serial }) => {
    const { text: t } = await readLogcat({ serial, appPackage, minLevel, tags, maxLines, mappingFile, clear: clearAfter });
    return text(t);
  })
);

server.registerTool(
  'logcat_clear',
  {
    title: 'Clear logcat',
    description: 'Clears the device log buffer. Call before reproducing a bug so the next logcat read only contains relevant output.',
    inputSchema: { serial },
  },
  wrap(async ({ serial }) => { await A.adb(['logcat', '-c'], { serial }); return text('logcat buffer cleared'); })
);

// ---------------------------------------------------------------- 3. ADB / device
server.registerTool(
  'android_devices',
  { title: 'List devices', description: 'Lists attached Android devices and emulators with serial, state and model.', inputSchema: {} },
  wrap(async () => {
    const d = await A.listDevices();
    return text(d.length ? d.map((x) => `${x.serial}  ${x.state}${x.model ? `  ${x.model}` : ''}`).join('\n') : 'No devices attached.');
  })
);

server.registerTool(
  'android_install',
  {
    title: 'Install APK',
    description: 'Installs (replaces) an APK on the device and grants runtime permissions.',
    inputSchema: { apkPath: z.string(), serial },
  },
  wrap(async ({ apkPath, serial }) => text(await A.installApk(apkPath, { serial })))
);

server.registerTool(
  'android_launch',
  {
    title: 'Launch / stop / reset app',
    description: 'Launch an app by package (default launcher activity, or a specific activity), force-stop it, or clear its data.',
    inputSchema: {
      appPackage: z.string(),
      action: z.enum(['launch', 'stop', 'restart', 'clear_data']).optional().describe('Default launch'),
      activity: z.string().optional().describe('Optional activity, e.g. .MainActivity'),
      serial,
    },
  },
  wrap(async ({ appPackage, action = 'launch', activity, serial }) => {
    if (action === 'stop') return text(await A.stopApp(appPackage, { serial }));
    if (action === 'clear_data') return text(await A.clearAppData(appPackage, { serial }));
    if (action === 'restart') await A.stopApp(appPackage, { serial });
    await A.launchApp(appPackage, { serial, activity });
    return text(`launched ${appPackage}`);
  })
);

server.registerTool(
  'ui_dump',
  {
    title: 'Read the screen as text',
    description:
      'Dumps the current screen as compact text instead of an image: one line per meaningful element with its label, resource id, flags (click/scroll/checked) and the (x,y) centre to pass to android_tap. ' +
      'Far cheaper than a screenshot. Call this before tapping and again after each action.',
    inputSchema: { interactiveOnly: z.boolean().optional().describe('Only clickable/scrollable/editable elements'), serial },
  },
  wrap(async ({ interactiveOnly, serial }) => {
    const xml = await A.dumpUiXml({ serial });
    const r = A.compactUiHierarchy(xml, { interactiveOnly });
    return text(r.count ? r.text : 'No UI elements found (screen locked, secure window, or app still loading?).');
  })
);

server.registerTool(
  'android_tap',
  { title: 'Tap', description: 'Taps at screen coordinates (use the @(x,y) from ui_dump).', inputSchema: { x: z.number(), y: z.number(), serial } },
  wrap(async ({ x, y, serial }) => { await A.tap(x, y, { serial }); return text(`tapped (${x},${y})`); })
);

server.registerTool(
  'android_swipe',
  {
    title: 'Swipe / scroll',
    description: 'Swipes between two points. To scroll a list down, swipe from low to high y.',
    inputSchema: { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), durationMs: z.number().optional(), serial },
  },
  wrap(async ({ x1, y1, x2, y2, durationMs, serial }) => { await A.swipe(x1, y1, x2, y2, durationMs, { serial }); return text('swiped'); })
);

server.registerTool(
  'android_type',
  {
    title: 'Type text / press key',
    description: 'Types text into the focused field, or presses a key (back, home, enter, recents, delete, tab, menu).',
    inputSchema: { text: z.string().optional(), key: z.string().optional(), serial },
  },
  wrap(async ({ text: t, key, serial }) => {
    if (!t && !key) throw new Error('Provide text or key');
    if (t) await A.typeText(t, { serial });
    if (key) await A.pressKey(key, { serial });
    return text(`${t ? 'typed text' : ''}${t && key ? ' and ' : ''}${key ? `pressed ${key}` : ''}`);
  })
);

server.registerTool(
  'android_screenshot',
  {
    title: 'Screenshot',
    description: 'Takes a screenshot and returns it as an image. Prefer ui_dump; use this when layout or visuals matter (colors, overlap, clipped text).',
    inputSchema: { savePath: z.string().optional().describe('Also save the PNG to this path'), serial },
  },
  wrap(async ({ savePath, serial }) => {
    const png = await A.screenshotPng({ serial });
    if (savePath) await writeFile(path.resolve(savePath), png);
    return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
  })
);

server.registerTool(
  'android_current_screen',
  {
    title: 'Current activity',
    description: 'Returns the activity currently in focus (package/Activity). Handy to confirm navigation or detect that the app crashed to the launcher.',
    inputSchema: { serial },
  },
  wrap(async ({ serial }) => text((await A.currentFocus({ serial })) || 'unknown'))
);

await server.connect(new StdioServerTransport());
