import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { capList, capText, clip } from './util.js';

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

const HINTS = [
  {
    id: 'kotlin-ksp-mismatch',
    test: /(?:ksp-[\w.-]+ is too old for kotlin|Module was compiled with an incompatible version of Kotlin|supports only Kotlin Gradle plugin version|Kotlin Gradle plugin .* is incompatible|KSP .* (?:requires|is not compatible))/i,
    hint: 'Kotlin/KSP/AGP version mismatch: KSP version must start with your Kotlin version (e.g. Kotlin 2.0.21 -> ksp 2.0.21-1.0.x), and AGP must support that Kotlin. Align them in libs.versions.toml.',
  },
  {
    id: 'jdk',
    test: /(?:Unsupported class file major version \d+|requires Java \d+|Could not target platform: 'Java SE \d+'|invalid source release|Unsupported Java\.|Inconsistent JVM-target compatibility|Dependency requires at least JVM runtime version \d+)/i,
    hint: 'JDK mismatch: Gradle/AGP and your project target different Java versions. AGP 8.x needs JDK 17 (set JAVA_HOME or Android Studio > Gradle JDK) and matching compileOptions/jvmTarget.',
  },
  {
    id: 'missing-sdk',
    test: /(?:SDK location not found|Failed to find target with hash string|Failed to install the following Android SDK packages|License for package .* not accepted|Failed to find Build Tools revision|No installed build tools found)/i,
    hint: 'Android SDK problem: set sdk.dir in local.properties or ANDROID_HOME, install the missing platform/build-tools, and run `sdkmanager --licenses`.',
  },
  {
    id: 'duplicate-class',
    test: /Duplicate class \S+ found in modules/,
    hint: 'Duplicate classes: two dependencies bundle the same class. Run gradle_deps_conflicts, then exclude the duplicate or align versions (often a kotlin-stdlib-jdk7/jdk8 or support-vs-androidx clash).',
  },
  {
    id: 'resolve-network',
    test: /(?:Could not GET|Could not HEAD|UnknownHostException|Connect timed out|Read timed out|Network is unreachable|PKIX path building failed|Connection refused|Premature end of Content-Length)/i,
    hint: 'Dependency download failed due to network/proxy/TLS, not your build file. Retry, check proxy settings in ~/.gradle/gradle.properties, or use --offline if dependencies are cached.',
  },
  {
    id: 'resolve-missing',
    test: /Could not (?:resolve|find) [\w.-]+:[\w.-]+:[^\s]+[\s\S]{0,400}?(?:Searched in the following locations|Required by)/,
    hint: 'Dependency not found in any repository: check the coordinates/version, and that the needed repository (google(), mavenCentral(), maven { url ... } / JitPack) is in settings.gradle dependencyResolutionManagement.',
    unless: 'resolve-network',
  },
  {
    id: 'oom',
    test: /(?:java\.lang\.OutOfMemoryError|Java heap space|GC overhead limit exceeded|Metaspace|Gradle build daemon disappeared unexpectedly)/,
    hint: 'Out of memory: add to gradle.properties: org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g  (and kotlin.daemon.jvmargs=-Xmx3g if Kotlin compile died).',
  },
  {
    id: 'r8-missing-rules',
    test: /(?:Missing class \S+ \(referenced from|missing_rules\.txt|R8: Missing class)/,
    hint: 'R8 missing rules: copy the suggested -dontwarn lines from app/build/outputs/mapping/<variant>/missing_rules.txt into proguard-rules.pro (or add the library\'s consumer rules).',
  },
];

/** Detect common root causes in raw Gradle output. Returns [{id, hint}] (max 4). */
export function detectHints(raw) {
  const text = raw.replace(ANSI, '');
  const hit = new Set();
  const out = [];
  for (const h of HINTS) {
    if (h.test.test(text)) { hit.add(h.id); out.push(h); }
  }
  return out.filter((h) => !(h.unless && hit.has(h.unless))).slice(0, 4).map(({ id, hint }) => ({ id, hint }));
}

/**
 * Attach a source snippet (2 lines before/after) to the first `max` errors that have a readable file:line.
 * `root` is used to resolve relative paths.
 */
export function attachSnippets(errors, root, { max = 5, radius = 2 } = {}) {
  let n = 0;
  for (const e of errors) {
    if (n >= max) break;
    if (!e.file || !e.line) continue;
    const candidates = path.isAbsolute(e.file) ? [e.file, path.join(root, e.file)] : [path.join(root, e.file)];
    const f = candidates.find((c) => existsSync(c));
    if (!f) continue;
    try {
      const src = readFileSync(f, 'utf8').split(/\r?\n/);
      const from = Math.max(1, e.line - radius);
      const to = Math.min(src.length, e.line + radius);
      if (e.line > src.length) continue;
      const w = String(to).length;
      const rows = [];
      for (let i = from; i <= to; i++) rows.push(`${i === e.line ? '>' : ' '} ${String(i).padStart(w)} | ${clip(src[i - 1], 140)}`);
      e.snippet = rows.join('\n');
      n++;
    } catch { /* unreadable: skip */ }
  }
}

/** Render the parsed result as compact text for an agent. Caps list sizes so output stays small. */
export function formatGradleResult(r, { maxErrors = 20, maxWarnings = 5, includeWarnings = true, maxChars = 14000 } = {}) {
  const out = [];
  out.push(`BUILD ${r.outcome}${r.duration ? ` in ${r.duration}` : ''}`);
  if (r.failedTasks.length) out.push(`Failed tasks: ${r.failedTasks.join(', ')}`);
  if (r.errorCount) {
    const { items, more } = capList(r.errors, maxErrors);
    out.push(`\nErrors (${r.errorCount}):`);
    items.forEach((e, i) => {
      const loc = e.file ? `${shorten(e.file)}${e.line ? `:${e.line}` : ''}${e.column ? `:${e.column}` : ''}` : e.kind;
      out.push(`${i + 1}. [${e.kind}] ${loc} - ${clip(e.message, 300)}`);
      if (e.snippet) out.push(e.snippet.split('\n').map((l) => `     ${l}`).join('\n'));
      else if (e.context) out.push(`     > ${e.context}`);
    });
    if (more) out.push(`(truncated ${more} more)`);
  }
  if (r.whatWentWrong && (r.outcome === 'FAILED' || !r.errorCount)) {
    out.push(`\nGradle says: ${clip(r.whatWentWrong.join(' | '), 1200)}`);
  }
  if (r.hints && r.hints.length) {
    out.push('\nLikely cause:');
    r.hints.forEach((h) => out.push(`- ${h.hint}`));
  }
  if (includeWarnings && r.warningCount) {
    const { items, more } = capList(r.warnings, maxWarnings);
    out.push(`\nWarnings: ${r.warningCount} total, ${r.uniqueWarnings} unique:`);
    items.forEach((w) => out.push(`- x${w.count} ${clip(w.message, 200)}`));
    if (more) out.push(`(truncated ${more} more)`);
  }
  return capText(out.join('\n'), maxChars);
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
      parsed.hints = detectHints(buf);
      attachSnippets(parsed.errors, found.root);
      if (parsed.outcome === 'UNKNOWN') parsed.outcome = code === 0 ? 'SUCCESSFUL' : 'FAILED';
      resolve({ parsed, exitCode: code, rawLength: buf.length, raw: buf });
    });
  });
}
