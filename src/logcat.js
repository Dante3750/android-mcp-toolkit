import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { adb, getPid } from './adb.js';
import { capText, clip } from './util.js';

const execFileP = promisify(execFile);

// threadtime format: "MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message"
const THREADTIME = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.+?)\s*: (.*)$/;
const LEVEL_RANK = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };

export function parseLogLine(line) {
  const m = line.match(THREADTIME);
  if (!m) return null;
  return { time: m[1], pid: m[2], tid: m[3], level: m[4], tag: m[5], msg: m[6] };
}

const STACK_LINE = /^\s+(at |\.\.\. \d+ more|Caused by: )/;
const FRAMEWORK_FRAME = /^at (java\.|javax\.|android\.|androidx\.|kotlin\.|kotlinx\.|dalvik\.|libcore\.|sun\.|com\.android\.|org\.apache\.|okhttp3\.|retrofit2\.)/;

/** Normalise a message so near-identical lines (different numbers, hashes) collapse together. */
function fingerprint(e) {
  return `${e.level}|${e.tag}|${e.msg.replace(/0x[0-9a-f]+/gi, '0x#').replace(/\b\d+(\.\d+)?\b/g, '#')}`;
}

/**
 * Condense raw `adb logcat -d -v threadtime` output.
 *  - filters by pid and minimum level
 *  - collapses stack traces into the exception line + top frames
 *  - dedupes repeated/near-identical lines (x N)
 *  - extracts crashes (FATAL EXCEPTION) and ANRs into a separate list
 */
export function condenseLogcat(raw, { pid, minLevel = 'I', tags, maxLines = 80, appPackage, stackFrames = 6, sinceTime } = {}) {
  const min = LEVEL_RANK[minLevel] ?? 2;
  const lines = raw.split(/\r?\n/);

  const entries = [];
  let last = null;
  for (const line of lines) {
    const e = parseLogLine(line);
    if (e) { entries.push(e); last = e; continue; }
    // continuation lines (raw stack frames without a header) attach to the previous entry
    if (last && STACK_LINE.test(line)) (last.stack ||= []).push(line.trim());
  }

  const crashes = [];
  const anrs = [];

  // Crash detection runs on all entries for the pid (ignores minLevel/tags filter)
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (pid && e.pid !== pid && !(e.tag === 'AndroidRuntime' || e.tag === 'ActivityManager')) continue;

    if (sinceTime && e.time < sinceTime) continue;
    if (e.tag === 'AndroidRuntime' && /FATAL EXCEPTION/.test(e.msg)) {
      const block = [];
      let j = i + 1;
      while (j < entries.length && entries[j].tag === 'AndroidRuntime') { block.push(entries[j].msg); j++; }
      const processLine = block.find((l) => l.startsWith('Process:'));
      const crashPid = entries[i].pid;
      if (pid && crashPid !== pid && appPackage && processLine && !processLine.includes(appPackage)) continue;
      // First line that looks like a qualified exception class, e.g. "java.lang.IllegalStateException: msg".
      // Skips the "Process: pkg, PID: n" header and stack frames.
      const exIdx = block.findIndex((l) => {
        const s = l.trim();
        return !s.startsWith('Process:') && !/^at /.test(s) && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+(: .*)?$/.test(s);
      });
      const exception = exIdx >= 0 ? block[exIdx] : block.find((l) => !l.startsWith('Process:')) || '(no exception text)';
      const frames = block.filter((l) => /^\s*at /.test(l)).map((l) => l.trim());
      const causes = block.filter((l) => l.startsWith('Caused by: '));
      // "App frames" = anything that isn't framework/library code. We can't rely on the applicationId matching the
      // code package (it often doesn't), so exclude well-known framework prefixes instead of matching the app id.
      const appFrames = frames.filter((f) => !FRAMEWORK_FRAME.test(f) || (appPackage && f.includes(appPackage)));
      crashes.push({
        time: e.time,
        thread: e.msg.replace('FATAL EXCEPTION: ', ''),
        process: processLine?.replace('Process: ', '').split(',')[0],
        exception,
        rootCause: causes.length ? causes[causes.length - 1].replace('Caused by: ', '') : undefined,
        topFrames: frames.slice(0, stackFrames),
        appFrames: appFrames.slice(0, stackFrames),
        totalFrames: frames.length,
      });
      i = j - 1;
      continue;
    }
    if (e.tag === 'ActivityManager' && /ANR in /.test(e.msg)) {
      anrs.push({ time: e.time, message: e.msg });
    }
  }

  // Regular (non-crash) lines
  const out = [];
  let prevFp = null;
  let total = 0;
  for (const e of entries) {
    if (pid && e.pid !== pid) continue;
    if (e.tag === 'AndroidRuntime') continue; // crashes reported separately
    if ((LEVEL_RANK[e.level] ?? 0) < min) continue;
    if (tags && tags.length && !tags.includes(e.tag)) continue;
    if (sinceTime && e.time < sinceTime) continue;
    total++;

    const fp = fingerprint(e);
    const prev = out[out.length - 1];
    if (prev && fp === prevFp) { prev.count++; continue; }
    // dedupe non-adjacent repeats of identical lines too (spammy tags)
    const dup = out.find((o) => o.fp === fp);
    if (dup && (e.level === 'D' || e.level === 'V' || e.level === 'I')) { dup.count++; continue; }

    const item = { fp, time: e.time, level: e.level, tag: e.tag, msg: e.msg, count: 1 };
    if (e.stack && e.stack.length) {
      item.stack = e.stack.slice(0, stackFrames);
      if (e.stack.length > stackFrames) item.stack.push(`... ${e.stack.length - stackFrames} more frames`);
    }
    out.push(item);
    prevFp = fp;
  }

  // Prioritise: keep all warnings/errors, then most recent infos, within maxLines
  let shown = out;
  let truncated = 0;
  if (out.length > maxLines) {
    const important = out.filter((o) => LEVEL_RANK[o.level] >= 3);
    const rest = out.filter((o) => LEVEL_RANK[o.level] < 3);
    // Hard cap: if warnings/errors alone exceed maxLines, keep the most recent ones.
    const keptImportant = important.length > maxLines ? important.slice(important.length - maxLines) : important;
    const keepRest = Math.max(0, maxLines - keptImportant.length);
    const keepSet = new Set([...keptImportant, ...(keepRest ? rest.slice(-keepRest) : [])]);
    shown = out.filter((o) => keepSet.has(o));
    truncated = out.length - shown.length;
  }

  return {
    rawLines: lines.length,
    matchedLines: total,
    shownLines: shown.length,
    truncated,
    crashes,
    anrs,
    lines: shown.map(({ fp, ...rest }) => rest),
  };
}

export function formatLogcat(r) {
  const out = [];
  out.push(`logcat: ${r.rawLines} raw lines -> ${r.matchedLines} matched -> ${r.shownLines} shown after dedupe${r.truncated ? ` (${r.truncated} older low-priority entries dropped)` : ''}`);

  for (const c of r.crashes) {
    out.push(`\nCRASH at ${c.time} in ${c.process || 'unknown process'} (thread ${c.thread})`);
    out.push(`  ${c.exception}`);
    if (c.rootCause && c.rootCause !== c.exception) out.push(`  root cause: ${c.rootCause}`);
    if (c.appFrames.length) {
      out.push('  app frames:');
      c.appFrames.forEach((f) => out.push(`    ${f}`));
    } else {
      out.push('  top frames:');
      c.topFrames.forEach((f) => out.push(`    ${f}`));
    }
    if (c.totalFrames > Math.max(c.appFrames.length, c.topFrames.length)) out.push(`    (${c.totalFrames} frames total)`);
  }
  for (const a of r.anrs) out.push(`\nANR at ${a.time}: ${a.message}`);

  if (r.lines.length) out.push('');
  for (const l of r.lines) {
    out.push(`${l.time.slice(6)} ${l.level}/${l.tag}: ${clip(l.msg, 300)}${l.count > 1 ? ` (x${l.count})` : ''}`);
    if (l.stack) l.stack.forEach((s) => out.push(`    ${s}`));
  }
  return out.join('\n');
}

/**
 * Deobfuscate an R8/ProGuard stack trace with the `retrace` tool from the
 * Android SDK cmdline-tools. Returns null if retrace or the mapping file is unavailable.
 */
export async function retraceText(text, mappingFile) {
  if (!mappingFile || !existsSync(mappingFile)) return null;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const candidates = [
    process.env.RETRACE_PATH,
    sdk && path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'retrace'),
  ].filter(Boolean);
  const bin = candidates.find((c) => existsSync(c));
  if (!bin) return null;

  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(bin, [mappingFile], { stdio: ['pipe', 'pipe', 'ignore'] });
    let outBuf = '';
    child.stdout.on('data', (d) => (outBuf += d));
    child.on('close', () => resolve(outBuf || null));
    child.on('error', () => resolve(null));
    child.stdin.end(text);
  });
}

/** Parse "MM-DD HH:MM:SS.mmm" (no year) to ms in a fixed leap year; null if malformed. */
export function parseLogTime(t) {
  const m = t?.match(/^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})/);
  return m ? Date.UTC(2000, +m[1] - 1, +m[2], +m[3], +m[4], +m[5], +m[6]) : null;
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmtLogTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/** Cutoff timestamp string (logcat time format) for "the last sinceMs ms" relative to nowStr (device time). */
export function sinceCutoff(nowStr, sinceMs) {
  const now = parseLogTime(nowStr);
  return now == null ? undefined : fmtLogTime(now - sinceMs);
}

/** Latest entry timestamp in raw logcat output (fallback "now" when the device clock can't be read). */
export function lastLogTime(raw) {
  const all = raw.match(/^\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}/gm);
  return all ? all[all.length - 1] : undefined;
}

/** Fetch logcat from a device and condense it. `lines` is an alias for maxLines; `tag` adds to `tags`. */
export async function readLogcat({ serial, appPackage, minLevel = 'I', tags, tag, lines, maxLines = 80, sinceLines = 5000, sinceMs, mappingFile, clear = false, maxChars = 12000 } = {}) {
  const tagList = [...(tags || []), ...(tag ? [tag] : [])];
  const shown = lines ?? maxLines;
  const pid = appPackage ? await getPid(appPackage, { serial }) : null;
  const { stdout } = await adb(['logcat', '-d', '-v', 'threadtime', '-t', String(sinceLines)], { serial, timeoutMs: 30000 });

  let sinceTime;
  if (sinceMs) {
    let now;
    try { now = (await adb(['shell', 'date', '+%m-%d %H:%M:%S.000'], { serial })).stdout.trim(); } catch { /* fall back below */ }
    sinceTime = sinceCutoff(parseLogTime(now) != null ? now : lastLogTime(stdout), sinceMs);
  }

  const result = condenseLogcat(stdout, { pid, minLevel, tags: tagList, maxLines: shown, appPackage, sinceTime });
  // A crashed app has no live pid, so also report crashes from its process name even when pid is gone
  if (appPackage && !pid && result.crashes.length === 0) {
    const crashOnly = condenseLogcat(stdout, { minLevel: 'F', maxLines: 0, appPackage, sinceTime });
    result.crashes = crashOnly.crashes.filter((c) => !c.process || c.process.includes(appPackage));
  }

  let text = formatLogcat(result);
  if (mappingFile && result.crashes.length) {
    const retraced = await retraceText(text, mappingFile);
    if (retraced) text = retraced;
    else text += '\n\n(mappingFile given but retrace was not available; set RETRACE_PATH or install Android cmdline-tools)';
  }
  if (clear) await adb(['logcat', '-c'], { serial });
  return { text: capText(text, maxChars), pid, result };
}
