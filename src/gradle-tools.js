// Higher-level Gradle helpers: test results, project overview, task list, lint, dependency conflicts.
// Parsers are pure functions over text so they can be tested with fixtures.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { capList, clip, elements, decodeXml } from './util.js';

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// ------------------------------------------------------------------ JUnit test results

/** Parse one JUnit XML report into {name, tests, failures, errors, skipped, time, cases[]}. */
export function parseJUnitXml(xml) {
  const suites = elements(xml, 'testsuite');
  const out = [];
  for (const s of suites) {
    const cases = [];
    for (const c of elements(s.body, 'testcase')) {
      const fail = elements(c.body, 'failure')[0] || elements(c.body, 'error')[0];
      const skipped = /<skipped\b/.test(c.body);
      const entry = { classname: c.attrs.classname || s.attrs.name, name: c.attrs.name, time: +c.attrs.time || 0, status: fail ? 'failed' : skipped ? 'skipped' : 'passed' };
      if (fail) {
        const trace = decodeXml(fail.body.replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim();
        entry.message = (fail.attrs.message || trace.split('\n')[0] || '').trim();
        entry.type = fail.attrs.type;
        entry.location = findTestLocation(trace, entry.classname);
      }
      cases.push(entry);
    }
    // Some reporters omit counts: derive from cases when absent
    const failed = cases.filter((c) => c.status === 'failed').length;
    out.push({
      name: s.attrs.name,
      tests: +s.attrs.tests || cases.length,
      failures: failed || (+s.attrs.failures || 0) + (+s.attrs.errors || 0),
      skipped: +s.attrs.skipped || cases.filter((c) => c.status === 'skipped').length,
      time: +s.attrs.time || 0,
      cases,
    });
  }
  return out;
}

/** From a stack trace, find file:line for the test class itself (else first non-framework frame). */
export function findTestLocation(trace, classname = '') {
  const frames = [...trace.matchAll(/at\s+([^()\n]+?)\(([\w$.]+\.(?:kt|java|groovy|scala)):(\d+)\)/g)];
  const outer = classname.replace(/\$.*$/, '');
  const own = frames.find((f) => f[1].startsWith(outer + '.') || f[1].startsWith(outer + '$'));
  const notFramework = frames.find((f) => !/^(org\.junit|junit\.|java\.|jdk\.|sun\.|kotlin\.|kotlinx\.coroutines|org\.gradle|worker\.org\.gradle|org\.mockito|io\.mockk|org\.robolectric|org\.hamcrest|com\.google\.common\.truth)/.test(f[1]));
  const f = own || notFramework;
  return f ? `${f[2]}:${f[3]}` : undefined;
}

/** Aggregate suites. */
export function summarizeTests(suites) {
  const s = { suites: suites.length, tests: 0, failed: 0, skipped: 0, passed: 0, time: 0, failures: [] };
  for (const su of suites) {
    s.tests += su.tests; s.failed += su.failures; s.skipped += su.skipped; s.time += su.time;
    for (const c of su.cases) if (c.status === 'failed') s.failures.push(c);
  }
  s.passed = Math.max(0, s.tests - s.failed - s.skipped);
  return s;
}

export function formatTestSummary(s, { maxFailures = 15 } = {}) {
  const out = [`Tests: ${s.tests} run, ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (${s.time.toFixed(1)}s)`];
  const { items, more } = capList(s.failures, maxFailures);
  items.forEach((f, i) => {
    out.push(`${i + 1}. ${f.classname.split('.').pop()} > ${f.name}${f.location ? `  @ ${f.location}` : ''}`);
    if (f.message) out.push(`     ${clip(f.message.replace(/\s+/g, ' '), 300)}`);
  });
  if (more) out.push(`(truncated ${more} more)`);
  return out.join('\n');
}

/** Gradle module path (":feature:login") to a directory under root. */
export function moduleDir(root, module = ':app') {
  const rel = module.replace(/^:/, '').split(':').filter(Boolean).join(path.sep);
  return path.join(root, rel);
}

function walk(dir, pred, out = [], depth = 0) {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, pred, out, depth + 1);
    else if (pred(p)) out.push(p);
  }
  return out;
}

/** Read build/test-results/**.xml modified at or after sinceMs (avoids reporting stale runs). */
export function collectTestResults(root, module, { sinceMs = 0 } = {}) {
  const dir = path.join(moduleDir(root, module), 'build', 'test-results');
  const files = walk(dir, (p) => p.endsWith('.xml') && path.basename(p).startsWith('TEST-') && statSync(p).mtimeMs >= sinceMs);
  const suites = [];
  for (const f of files) suites.push(...parseJUnitXml(readFileSync(f, 'utf8')));
  return { files: files.length, summary: summarizeTests(suites) };
}

// ------------------------------------------------------------------ Project overview

const Q = /["']([^"']+)["']/g;

/** Extract module paths from settings.gradle(.kts) text. */
export function parseSettings(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const modules = [];
  const add = (m) => { const p = m.startsWith(':') ? m : `:${m}`; if (!modules.includes(p)) modules.push(p); };
  // include(":a", ":b") possibly multi-line; include ':a', ':b' (Groovy, comma-continued lines)
  for (const m of clean.matchAll(/\binclude\s*(\()?/g)) {
    const start = m.index + m[0].length;
    let chunk;
    if (m[1]) {
      const end = clean.indexOf(')', start);
      chunk = clean.slice(start, end < 0 ? undefined : end);
    } else {
      // Groovy: until a line that does not end with a comma
      let end = start;
      for (;;) {
        const nl = clean.indexOf('\n', end);
        const line = clean.slice(end, nl < 0 ? undefined : nl);
        end = nl < 0 ? clean.length : nl + 1;
        if (!/,\s*$/.test(line) || nl < 0) break;
      }
      chunk = clean.slice(start, end);
    }
    for (const q of chunk.matchAll(Q)) add(q[1]);
  }
  const rootName = clean.match(/rootProject\.name\s*=\s*["']([^"']+)["']/)?.[1];
  return { rootName, modules };
}

/** Classify a module from its build file. */
export function classifyBuildFile(text) {
  if (!text) return 'unknown';
  if (/com\.android\.application|android\.application/.test(text)) return 'android-app';
  if (/com\.android\.library|android\.library/.test(text)) return 'android-lib';
  if (/com\.android\.dynamic-feature/.test(text)) return 'dynamic-feature';
  if (/kotlin\("jvm"\)|org\.jetbrains\.kotlin\.jvm|kotlin-jvm|java-library|`java-library`|id\(["']java["']\)|kotlin\.jvm/.test(text)) return 'jvm-lib';
  return 'other';
}

export function readProjectOverview(root) {
  const sFile = ['settings.gradle.kts', 'settings.gradle'].map((f) => path.join(root, f)).find(existsSync);
  if (!sFile) throw new Error(`No settings.gradle(.kts) in ${root}`);
  const { rootName, modules } = parseSettings(readFileSync(sFile, 'utf8'));
  const list = modules.map((m) => {
    const dir = moduleDir(root, m);
    const bf = ['build.gradle.kts', 'build.gradle'].map((f) => path.join(dir, f)).find(existsSync);
    const text = bf ? readFileSync(bf, 'utf8') : '';
    return { module: m, type: bf ? classifyBuildFile(text) : 'missing-dir', buildFile: bf ? path.basename(bf) : undefined };
  });
  return { rootName, settingsFile: path.basename(sFile), modules: list };
}

export function formatOverview(o, { maxModules = 60 } = {}) {
  const out = [`${o.rootName || '(unnamed)'}: ${o.modules.length} module(s) [${o.settingsFile}]`];
  const { items, more } = capList(o.modules, maxModules);
  items.forEach((m) => out.push(`${m.module}  ${m.type}`));
  if (more) out.push(`(truncated ${more} more)`);
  return out.join('\n');
}

// ------------------------------------------------------------------ Task list

/** Parse `gradlew tasks --all` output into {group: [{name, desc}]}. */
export function parseTasks(raw) {
  const lines = raw.replace(ANSI, '').split(/\r?\n/);
  const groups = {};
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^-{5,}$/.test(l)) continue;
    if (lines[i + 1] && /^-{5,}$/.test(lines[i + 1]) && l.trim()) { cur = l.replace(/ tasks$/, '').trim(); groups[cur] ||= []; continue; }
    const m = l.match(/^([A-Za-z][\w:.-]*)(?: - (.*))?$/);
    if (m && cur && !/^(To see|BUILD|Tasks runnable|Rules|Pattern)/.test(l)) groups[cur].push({ name: m[1], desc: m[2] || '' });
  }
  return groups;
}

export function formatTasks(groups, { filter, maxTasks = 60 } = {}) {
  const f = filter ? filter.toLowerCase() : null;
  const flat = [];
  for (const [g, ts] of Object.entries(groups)) for (const t of ts) if (!f || t.name.toLowerCase().includes(f) || t.desc.toLowerCase().includes(f)) flat.push({ g, ...t });
  const { items, more } = capList(flat, maxTasks);
  const out = [`${flat.length} task(s)${f ? ` matching "${filter}"` : ''}`];
  let g = null;
  for (const t of items) {
    if (t.g !== g) { out.push(`[${t.g}]`); g = t.g; }
    out.push(`  ${t.name}${t.desc ? ` - ${clip(t.desc, 80)}` : ''}`);
  }
  if (more) out.push(`(truncated ${more} more; pass filter to narrow)`);
  return out.join('\n');
}

// ------------------------------------------------------------------ Lint

const SEV_RANK = { Fatal: 4, Error: 3, Warning: 2, Informational: 1, Ignore: 0 };

export function parseLintXml(xml) {
  return elements(xml, 'issue').map((i) => {
    const loc = elements(i.body, 'location')[0]?.attrs;
    return {
      id: i.attrs.id, severity: i.attrs.severity || 'Warning', category: i.attrs.category,
      priority: +i.attrs.priority || 0, message: i.attrs.message || i.attrs.summary || '',
      file: loc?.file, line: loc?.line ? +loc.line : undefined,
    };
  });
}

/** Group by id, rank by severity then priority then count. */
export function rankLint(issues, { minSeverity = 'Warning' } = {}) {
  const min = SEV_RANK[minSeverity] ?? 2;
  const groups = new Map();
  for (const i of issues) {
    if ((SEV_RANK[i.severity] ?? 0) < min) continue;
    const g = groups.get(i.id) || { id: i.id, severity: i.severity, category: i.category, priority: i.priority, count: 0, examples: [] };
    g.count++;
    if (g.examples.length < 3) g.examples.push(i);
    groups.set(i.id, g);
  }
  return [...groups.values()].sort((a, b) => (SEV_RANK[b.severity] - SEV_RANK[a.severity]) || (b.priority - a.priority) || (b.count - a.count));
}

export function formatLint(issues, { minSeverity = 'Warning', maxIssues = 15, root = '' } = {}) {
  const sev = {};
  for (const i of issues) sev[i.severity] = (sev[i.severity] || 0) + 1;
  const ranked = rankLint(issues, { minSeverity });
  const out = [`Lint: ${issues.length} issue(s) - ${Object.entries(sev).sort((a, b) => SEV_RANK[b[0]] - SEV_RANK[a[0]]).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`];
  const { items, more } = capList(ranked, maxIssues);
  items.forEach((g, n) => {
    const e = g.examples[0];
    const where = e.file ? ` @ ${path.relative(root, e.file) || e.file}${e.line ? `:${e.line}` : ''}` : '';
    out.push(`${n + 1}. [${g.severity}] ${g.id} x${g.count}${where}\n     ${clip(e.message, 200)}`);
  });
  if (more) out.push(`(truncated ${more} more)`);
  return out.join('\n');
}

export function findLintReports(root, module = ':app', { sinceMs = 0 } = {}) {
  const dir = path.join(moduleDir(root, module), 'build', 'reports');
  return walk(dir, (p) => /^lint-results.*\.xml$/.test(path.basename(p)) && statSync(p).mtimeMs >= sinceMs);
}

// ------------------------------------------------------------------ Dependency conflicts

/**
 * Parse `gradlew :app:dependencies --configuration X` output.
 * Reports modules whose requested version differs from the resolved one, plus unresolved deps.
 */
export function parseDependencyConflicts(raw) {
  const lines = raw.replace(ANSI, '').split(/\r?\n/);
  const map = new Map();
  const unresolved = new Map();
  const stack = [];
  const re = /^((?:[| ]{5})*)[+\\]--- (.+)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const depth = m[1].length / 5;
    let body = m[2].replace(/\s*\((?:\*|c|n)\)\s*$/, '').trim();
    if (body.startsWith('project ')) { stack.length = depth; stack[depth] = body.split(' ')[1]; continue; }
    const failed = /\sFAILED$/.test(body);
    body = body.replace(/\sFAILED$/, '');
    const x = body.match(/^([^:\s]+):([^:\s]+)(?::(\{[^}]+\}|[^\s]+))?(?:\s+->\s+(\S+))?$/);
    if (!x) continue;
    const [, group, artifact, reqRaw, resolved] = x;
    const key = `${group}:${artifact}`;
    stack.length = depth;
    stack[depth] = key;
    const parent = depth > 0 ? stack[depth - 1] : '(declared)';
    const req = reqRaw?.replace(/^\{(?:strictly|require|prefer|reject)?\s*|\}$/g, '').trim();
    if (failed) { unresolved.set(key, { key, version: req }); continue; }
    if (resolved && req && req !== resolved) {
      const e = map.get(key) || { key, resolved, requested: new Set(), parents: new Set() };
      e.resolved = resolved; e.requested.add(req); e.parents.add(parent);
      map.set(key, e);
    }
  }
  const conflicts = [...map.values()].map((c) => ({ key: c.key, resolved: c.resolved, requested: [...c.requested], parents: [...c.parents].slice(0, 3), majorJump: [...c.requested].some((r) => major(r) !== null && major(r) !== major(c.resolved)) }));
  conflicts.sort((a, b) => (b.majorJump - a.majorJump) || (b.requested.length - a.requested.length));
  return { conflicts, unresolved: [...unresolved.values()] };
}

const major = (v) => { const m = String(v).match(/^(\d+)/); return m ? +m[1] : null; };

export function formatConflicts(r, { maxItems = 25 } = {}) {
  const out = [`Version conflicts: ${r.conflicts.length}${r.unresolved.length ? `, unresolved: ${r.unresolved.length}` : ''}`];
  const { items, more } = capList(r.conflicts, maxItems);
  items.forEach((c) => out.push(`- ${c.key}: ${c.requested.join(', ')} -> ${c.resolved}${c.majorJump ? '  (MAJOR jump)' : ''}  via ${c.parents.join(', ')}`));
  if (more) out.push(`(truncated ${more} more)`);
  r.unresolved.slice(0, 10).forEach((u) => out.push(`- UNRESOLVED ${u.key}${u.version ? `:${u.version}` : ''}`));
  return out.join('\n');
}
