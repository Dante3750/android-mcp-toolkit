#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { runGradle, formatGradleResult, findGradleWrapper } from './gradle.js';
import {
  collectTestResults, formatTestSummary, readProjectOverview, formatOverview, parseTasks, formatTasks,
  findLintReports, parseLintXml, formatLint, parseDependencyConflicts, formatConflicts,
} from './gradle-tools.js';
import { readLogcat } from './logcat.js';
import { capText } from './util.js';
import * as A from './adb.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const text = (t) => ({ content: [{ type: 'text', text: capText(t) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message || e) }] });
const wrap = (fn) => async (args) => { try { return await fn(args); } catch (e) { return fail(e); } };

const serial = z.string().optional().describe('Device serial; optional if one device');
const projectDir = z.string().describe('Absolute path to the Android project (gradlew is searched upwards)');
const module_ = z.string().optional().describe('Gradle module path, default ":app"');

// Annotation presets
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const tasksCache = new Map();
function cacheSig(root) {
  return ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'gradle/libs.versions.toml']
    .map((f) => { try { return statSync(path.join(root, f)).mtimeMs; } catch { return 0; } }).join('|');
}

export function createServer() {
const server = new McpServer({ name: 'android-mcp-toolkit', version: VERSION });

// ---------------------------------------------------------------- Gradle
server.registerTool(
  'gradle_build',
  {
    title: 'Run Gradle (filtered)',
    description: 'Runs ./gradlew; returns outcome, failed tasks, de-duplicated errors as file:line with code context, likely-cause hints, and a warning summary. Use instead of a shell gradlew.',
    inputSchema: {
      projectDir,
      tasks: z.array(z.string()).min(1).describe('e.g. ["assembleDebug"] or [":app:lintDebug"]'),
      extraArgs: z.array(z.string()).optional().describe('e.g. ["--offline"]'),
      includeWarnings: z.boolean().optional().describe('Default true'),
      maxErrors: z.number().int().min(1).max(100).optional().describe('Default 20'),
      saveFullLogTo: z.string().optional().describe('Write the raw log to this file'),
    },
    annotations: ACT,
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
    return { isError: exitCode !== 0, content: [{ type: 'text', text: capText(out, 16000) }] };
  })
);

server.registerTool(
  'gradle_test',
  {
    title: 'Run unit tests',
    description: 'Runs unit tests for a module (optionally filtered) and returns pass/fail counts plus each failure with message and file:line, read from build/test-results XML.',
    inputSchema: {
      projectDir,
      module: module_,
      task: z.string().optional().describe('Default "testDebugUnitTest"'),
      filter: z.string().optional().describe('--tests pattern, e.g. "com.foo.BarTest" or "*Login*"'),
      maxFailures: z.number().int().min(1).max(50).optional().describe('Default 15'),
    },
    annotations: ACT,
  },
  wrap(async ({ projectDir, module, task, filter, maxFailures }) => {
    const mod = module || ':app';
    const found = findGradleWrapper(projectDir);
    if (!found) throw new Error(`No gradlew found at or above ${projectDir}`);
    const started = Date.now() - 2000;
    const args = ['--continue'];
    if (filter) args.push('--tests', filter);
    const { parsed, exitCode } = await runGradle({ projectDir, tasks: [`${mod}:${task || 'testDebugUnitTest'}`], extraArgs: args });
    const res = collectTestResults(found.root, mod, { sinceMs: started });
    let out;
    if (res.files === 0) {
      out = `No test result files produced.\n${formatGradleResult(parsed, { includeWarnings: false })}`;
    } else {
      out = formatTestSummary(res.summary, { maxFailures: maxFailures ?? 15 });
      if (parsed.errorCount && !res.summary.failed) out += `\n\n${formatGradleResult(parsed, { includeWarnings: false })}`;
    }
    return { isError: exitCode !== 0, content: [{ type: 'text', text: capText(out, 14000) }] };
  })
);

server.registerTool(
  'gradle_modules',
  {
    title: 'Project modules',
    description: 'Cheap project overview: modules from settings.gradle(.kts) with type (app/library/jvm). Does not run Gradle.',
    inputSchema: { projectDir },
    annotations: READ,
  },
  wrap(async ({ projectDir }) => {
    const found = findGradleWrapper(projectDir);
    const root = found ? found.root : path.resolve(projectDir);
    return text(formatOverview(readProjectOverview(root)));
  })
);

server.registerTool(
  'gradle_tasks',
  {
    title: 'List Gradle tasks',
    description: 'Lists Gradle tasks (cached until build files change). Use filter to narrow, e.g. "lint" or "assemble".',
    inputSchema: {
      projectDir,
      filter: z.string().optional().describe('Substring of task name/description'),
      refresh: z.boolean().optional().describe('Ignore cache'),
    },
    annotations: READ,
  },
  wrap(async ({ projectDir, filter, refresh }) => {
    const found = findGradleWrapper(projectDir);
    if (!found) throw new Error(`No gradlew found at or above ${projectDir}`);
    const sig = cacheSig(found.root);
    let hit = tasksCache.get(found.root);
    let note = '';
    if (!hit || hit.sig !== sig || refresh) {
      const { raw, exitCode } = await runGradle({ projectDir, tasks: ['tasks', '--all'], extraArgs: ['-q'] });
      const groups = parseTasks(raw);
      if (!Object.keys(groups).length) throw new Error(`Could not list tasks (exit ${exitCode}). Last output:\n${raw.split('\n').slice(-10).join('\n')}`);
      hit = { sig, groups };
      tasksCache.set(found.root, hit);
    } else note = ' (cached)';
    return text(formatTasks(hit.groups, { filter }) + note);
  })
);

server.registerTool(
  'lint_summary',
  {
    title: 'Lint summary',
    description: 'Ranks Android Lint issues (severity, then priority, grouped by id) from the last lint XML report. Set run=true to run lintDebug first.',
    inputSchema: {
      projectDir,
      module: module_,
      run: z.boolean().optional().describe('Run :module:lintDebug first'),
      minSeverity: z.enum(['Informational', 'Warning', 'Error', 'Fatal']).optional().describe('Default Warning'),
      maxIssues: z.number().int().min(1).max(50).optional().describe('Default 15'),
    },
    annotations: ACT,
  },
  wrap(async ({ projectDir, module, run, minSeverity, maxIssues }) => {
    const mod = module || ':app';
    const found = findGradleWrapper(projectDir);
    const root = found ? found.root : path.resolve(projectDir);
    const started = Date.now() - 2000;
    let prefix = '';
    if (run) {
      const r = await runGradle({ projectDir, tasks: [`${mod}:lintDebug`], extraArgs: ['--continue'] });
      if (r.parsed.errorCount && r.parsed.failedTasks.some((t) => !/lint/i.test(t))) prefix = `${formatGradleResult(r.parsed, { includeWarnings: false })}\n\n`;
    }
    const reports = findLintReports(root, mod, { sinceMs: run ? started : 0 })
      .map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
    if (!reports.length) return text(`${prefix}No lint-results*.xml under ${mod}/build/reports. Call again with run=true.`);
    const issues = parseLintXml(readFileSync(reports[0].f, 'utf8'));
    return text(`${prefix}${formatLint(issues, { minSeverity: minSeverity || 'Warning', maxIssues: maxIssues ?? 15, root })}\n(report: ${path.relative(root, reports[0].f)})`);
  })
);

server.registerTool(
  'gradle_deps_conflicts',
  {
    title: 'Dependency conflicts',
    description: 'Runs the dependencies report for one configuration and lists only modules whose requested version was upgraded/changed, flagging major jumps and unresolved deps.',
    inputSchema: {
      projectDir,
      module: module_,
      configuration: z.string().optional().describe('Default "debugRuntimeClasspath"'),
      maxItems: z.number().int().min(1).max(100).optional().describe('Default 25'),
    },
    annotations: ACT,
  },
  wrap(async ({ projectDir, module, configuration, maxItems }) => {
    const { raw, exitCode } = await runGradle({
      projectDir, tasks: [`${module || ':app'}:dependencies`], extraArgs: ['--configuration', configuration || 'debugRuntimeClasspath', '-q'],
    });
    if (!/[+\\]--- /.test(raw)) throw new Error(`No dependency tree in output (exit ${exitCode}). Check module/configuration name. Tail:\n${raw.split('\n').slice(-8).join('\n')}`);
    return text(formatConflicts(parseDependencyConflicts(raw), { maxItems: maxItems ?? 25 }));
  })
);

// ---------------------------------------------------------------- Logcat
server.registerTool(
  'logcat',
  {
    title: 'Read logcat (condensed)',
    description: 'Condensed device log: filtered to one app (by PID), repeats collapsed (xN), stacks shortened, crashes/ANRs first with root cause and app frames. Optional mappingFile retraces R8.',
    inputSchema: {
      appPackage: z.string().optional().describe('Application id; strongly recommended'),
      minLevel: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).optional().describe('Default I'),
      tag: z.string().optional().describe('Only this tag'),
      tags: z.array(z.string()).optional().describe('Only these tags'),
      lines: z.number().int().min(1).max(500).optional().describe('Max lines shown (default 80)'),
      maxLines: z.number().int().min(1).max(500).optional().describe('Alias of lines'),
      sinceMs: z.number().int().min(1).optional().describe('Only entries from the last N ms'),
      mappingFile: z.string().optional().describe('R8 mapping.txt'),
      clearAfter: z.boolean().optional().describe('Clear buffer after reading'),
      serial,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  wrap(async ({ appPackage, minLevel, tag, tags, lines, maxLines, sinceMs, mappingFile, clearAfter, serial }) => {
    const { text: t } = await readLogcat({ serial, appPackage, minLevel, tag, tags, lines, maxLines: maxLines ?? 80, sinceMs, mappingFile, clear: clearAfter });
    return text(t);
  })
);

server.registerTool(
  'logcat_clear',
  {
    title: 'Clear logcat',
    description: 'Clears the device log buffer; call before reproducing a bug.',
    inputSchema: { serial },
    annotations: DESTROY,
  },
  wrap(async ({ serial }) => { await A.adb(['logcat', '-c'], { serial }); return text('logcat buffer cleared'); })
);

// ---------------------------------------------------------------- ADB / device
server.registerTool(
  'android_devices',
  { title: 'List devices', description: 'Lists attached devices/emulators: serial, state, model.', inputSchema: {}, annotations: READ },
  wrap(async () => {
    const d = await A.listDevices();
    return text(d.length ? d.map((x) => `${x.serial}  ${x.state}${x.model ? `  ${x.model}` : ''}`).join('\n') : 'No devices attached.');
  })
);

server.registerTool(
  'android_install',
  {
    title: 'Install APK',
    description: 'Installs (replaces) an APK and grants runtime permissions.',
    inputSchema: { apkPath: z.string(), serial },
    annotations: DESTROY,
  },
  wrap(async ({ apkPath, serial }) => text(await A.installApk(apkPath, { serial })))
);

server.registerTool(
  'android_launch',
  {
    title: 'Launch / stop / reset app',
    description: 'Launch (default or given activity), stop, restart, or clear_data (wipes app data).',
    inputSchema: {
      appPackage: z.string(),
      action: z.enum(['launch', 'stop', 'restart', 'clear_data']).optional().describe('Default launch'),
      activity: z.string().optional().describe('e.g. .MainActivity'),
      serial,
    },
    annotations: DESTROY,
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
    description: 'Current screen as compact text: label, id, flags and @(x,y) centre per element, for android_tap. Far cheaper than a screenshot; call before and after each action.',
    inputSchema: { interactiveOnly: z.boolean().optional().describe('Only clickable/scrollable/editable'), serial },
    annotations: READ,
  },
  wrap(async ({ interactiveOnly, serial }) => {
    const xml = await A.dumpUiXml({ serial });
    const r = A.compactUiHierarchy(xml, { interactiveOnly });
    return text(r.count ? r.text : 'No UI elements found (screen locked, secure window, or app still loading?).');
  })
);

server.registerTool(
  'android_tap',
  { title: 'Tap', description: 'Tap at x,y (use @(x,y) from ui_dump).', inputSchema: { x: z.number(), y: z.number(), serial }, annotations: ACT },
  wrap(async ({ x, y, serial }) => { await A.tap(x, y, { serial }); return text(`tapped (${x},${y})`); })
);

server.registerTool(
  'android_swipe',
  {
    title: 'Swipe / scroll',
    description: 'Swipe between two points; to scroll a list down swipe from high y to low y.',
    inputSchema: { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), durationMs: z.number().optional(), serial },
    annotations: ACT,
  },
  wrap(async ({ x1, y1, x2, y2, durationMs, serial }) => { await A.swipe(x1, y1, x2, y2, durationMs, { serial }); return text('swiped'); })
);

server.registerTool(
  'android_type',
  {
    title: 'Type text / press key',
    description: 'Type into the focused field, or press a key (back, home, enter, recents, delete, tab, menu).',
    inputSchema: { text: z.string().optional(), key: z.string().optional(), serial },
    annotations: ACT,
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
    description: 'Screenshot as an image. Prefer ui_dump; use for visuals (colors, overlap, clipping).',
    inputSchema: { savePath: z.string().optional().describe('Also save the PNG here'), serial },
    annotations: READ,
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
    description: 'Activity in focus (package/Activity); detects navigation or a crash to the launcher.',
    inputSchema: { serial },
    annotations: READ,
  },
  wrap(async ({ serial }) => text((await A.currentFocus({ serial })) || 'unknown'))
);

return server;
}

export async function startServer() {
  await createServer().connect(new StdioServerTransport());
}

// Allow `node src/server.js` directly, like before.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* not run directly */ }
if (isMain) await startServer();
