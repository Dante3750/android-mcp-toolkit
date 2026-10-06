import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Parse raw Gradle console output into a compact structured result.
 * Pure function: no I/O, easy to test.
 */
export function parseGradleOutput(raw) {
  const text = raw.replace(ANSI, '');
  const lines = text.split(/\r?\n/);

  const errors = [];
  const warningMap = new Map();
  const failedTasks = [];
  const whatWentWrong = [];
  let outcome = 'UNKNOWN';
  let duration = null;

  const seenErrors = new Set();
  const pushError = (e) => {
    const key = `${e.file || ''}:${e.line || ''}:${e.message}`;
    if (seenErrors.has(key)) return;
    seenErrors.add(key);
    errors.push(e);
  };
  const pushWarning = (key, sample) => {
    const cur = warningMap.get(key);
    if (cur) cur.count += 1;
    else warningMap.set(key, { message: sample, count: 1 });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Kotlin: e: file:///path/File.kt:12:34 message   (also "e: /path/File.kt: (12, 34): message" on old KGP)
    let m = line.match(/^e: (?:file:\/\/)?(.+?\.kts?):(\d+):(\d+)\s+(.*)$/);
    if (m) { pushError({ kind: 'kotlin', file: m[1], line: +m[2], column: +m[3], message: m[4].trim() }); continue; }
    m = line.match(/^e: (.+?\.kts?): \((\d+), (\d+)\): (.*)$/);
    if (m) { pushError({ kind: 'kotlin', file: m[1], line: +m[2], column: +m[3], message: m[4].trim() }); continue; }
    m = line.match(/^e: (.+)$/);
    if (m) { pushError({ kind: 'kotlin', message: m[1].trim() }); continue; }

    // Kotlin warnings: w: file:///path/File.kt:12:34 message
    m = line.match(/^w: (?:file:\/\/)?(.+?\.kts?):(\d+):(\d+)\s+(.*)$/) || line.match(/^w: (.+?\.kts?): \((\d+), (\d+)\): (.*)$/);
    if (m) { pushWarning(`kotlin:${m[4].trim()}`, `${m[4].trim()} (e.g. ${path.basename(m[1])}:${m[2]})`); continue; }
    if (/^w: /.test(line)) { pushWarning(`kotlin:${line.slice(3)}`, line.slice(3).trim()); continue; }

    // Java (javac): /path/File.java:12: error: message
    m = line.match(/^(.+?\.java):(\d+): error: (.*)$/);
    if (m) {
      const err = { kind: 'java', file: m[1], line: +m[2], message: m[3].trim() };
      // javac prints source line + caret on the next two lines; keep the source line as context
      if (lines[i + 1] && lines[i + 2] && /^\s*\^/.test(lines[i + 2])) err.context = lines[i + 1].trim();
      pushError(err);
      continue;
    }
    m = line.match(/^(.+?\.java):(\d+): warning: (.*)$/);
    if (m) { pushWarning(`java:${m[3].trim()}`, `${m[3].trim()} (e.g. ${path.basename(m[1])}:${m[2]})`); continue; }

    // AAPT2 / resource errors: /path/res/layout/x.xml:10: error: ...  or "ERROR: /path/x.xml:10: AAPT: error: ..."
    m = line.match(/^(?:ERROR: )?(.+?\.xml):(\d+)(?::\d+)?: (?:AAPT: )?error: (.*)$/);
    if (m) { pushError({ kind: 'resource', file: m[1], line: +m[2], message: m[3].trim() }); continue; }

    // Gradle deprecation / generic warnings
    if (/^WARNING: /.test(line)) { pushWarning(`gradle:${line}`, line.replace(/^WARNING: /, '').trim()); continue; }
    if (/deprecated/i.test(line) && /Gradle|AGP|plugin/i.test(line)) { pushWarning(`dep:${line}`, line.trim()); continue; }

    // Failed tasks
    m = line.match(/^> Task (\S+) FAILED$/);
    if (m) { if (!failedTasks.includes(m[1])) failedTasks.push(m[1]); continue; }
    m = line.match(/^Execution failed for task '(.+?)'\./);
    if (m) { if (!failedTasks.includes(m[1])) failedTasks.push(m[1]); continue; }

    // "* What went wrong:" block (take following non-empty lines until next "* " section)
    if (/^\* What went wrong:/.test(line)) {
      let j = i + 1;
      const block = [];
      while (j < lines.length && !/^\* /.test(lines[j]) && block.length < 12) {
        if (lines[j].trim()) block.push(lines[j].trim());
        j++;
      }
      whatWentWrong.push(block.join(' '));
      i = j - 1;
      continue;
    }

    // Test failures: "FooTest > bar FAILED"
    m = line.match(/^(\S.*? > .+?) FAILED$/);
    if (m && !line.startsWith('> Task')) { pushError({ kind: 'test', message: `${m[1]} FAILED` }); continue; }

    m = line.match(/^BUILD (SUCCESSFUL|FAILED)(?: in (.+))?$/);
    if (m) { outcome = m[1]; duration = m[2] || null; continue; }
  }

  const warnings = [...warningMap.values()].sort((a, b) => b.count - a.count);

  return {
    outcome,
    duration,
    failedTasks,
    errorCount: errors.length,
    errors,
    whatWentWrong: whatWentWrong.length ? whatWentWrong : undefined,
    warningCount: warnings.reduce((n, w) => n + w.count, 0),
    uniqueWarnings: warnings.length,
    warnings,
  };
}

/** Render the parsed result as compact text for an agent. Caps list sizes so output stays small. */
export function formatGradleResult(r, { maxErrors = 20, maxWarnings = 5, includeWarnings = true } = {}) {
  const out = [];
  out.push(`BUILD ${r.outcome}${r.duration ? ` in ${r.duration}` : ''}`);
  if (r.failedTasks.length) out.push(`Failed tasks: ${r.failedTasks.join(', ')}`);
  if (r.errorCount) {
    out.push(`\nErrors (${r.errorCount}${r.errorCount > maxErrors ? `, showing first ${maxErrors}` : ''}):`);
    r.errors.slice(0, maxErrors).forEach((e, i) => {
      const loc = e.file ? `${shorten(e.file)}${e.line ? `:${e.line}` : ''}${e.column ? `:${e.column}` : ''}` : e.kind;
      out.push(`${i + 1}. [${e.kind}] ${loc} - ${e.message}${e.context ? `\n     > ${e.context}` : ''}`);
    });
  }
  if (r.whatWentWrong && (r.outcome === 'FAILED' || !r.errorCount)) {
    out.push(`\nGradle says: ${r.whatWentWrong.join(' | ')}`);
  }
  if (includeWarnings && r.warningCount) {
    out.push(`\nWarnings: ${r.warningCount} total, ${r.uniqueWarnings} unique${r.uniqueWarnings > maxWarnings ? ` (top ${maxWarnings})` : ''}:`);
    r.warnings.slice(0, maxWarnings).forEach((w) => out.push(`- x${w.count} ${w.message}`));
  }
  return out.join('\n');
}

function shorten(p) {
  // Keep paths readable: drop everything before a typical source root
  const idx = p.search(/\/(src|app|build)\//);
  return idx > 0 ? p.slice(idx + 1) : p;
}

/** Find gradlew by walking up from projectDir. */
export function findGradleWrapper(projectDir) {
  let dir = path.resolve(projectDir);
  for (;;) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    if (existsSync(candidate)) return { wrapper: candidate, root: dir };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Run Gradle and return the filtered result. */
export function runGradle({ projectDir, tasks, extraArgs = [], timeoutMs = 20 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const found = findGradleWrapper(projectDir);
    if (!found) return reject(new Error(`No gradlew found at or above ${projectDir}`));

    const args = [...tasks, '--console=plain', '--warning-mode=summary', ...extraArgs];
    const child = spawn(found.wrapper, args, { cwd: found.root, env: process.env });
    let buf = '';
    const onData = (d) => { buf += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Gradle timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseGradleOutput(buf);
      if (parsed.outcome === 'UNKNOWN') parsed.outcome = code === 0 ? 'SUCCESSFUL' : 'FAILED';
      resolve({ parsed, exitCode: code, rawLength: buf.length, raw: buf });
    });
  });
}
