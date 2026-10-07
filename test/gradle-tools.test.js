import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseJUnitXml, summarizeTests, formatTestSummary, collectTestResults, findTestLocation,
  parseSettings, readProjectOverview, formatOverview, classifyBuildFile,
  parseTasks, formatTasks, parseLintXml, rankLint, formatLint, parseDependencyConflicts, formatConflicts,
} from '../src/gradle-tools.js';
import { capText, capList } from '../src/util.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('JUnit: counts, failures with message and file:line', () => {
  const s = summarizeTests(parseJUnitXml(fx('junit-fail.xml')));
  assert.equal(s.tests, 4);
  assert.equal(s.failed, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.passed, 1);
  const f = s.failures[0];
  assert.equal(f.name, 'empty password is rejected');
  assert.equal(f.location, 'LoginViewModelTest.kt:48');
  assert.match(f.message, /expected:<ERROR> but was:<IDLE>/);
  // error element with NPE: location is the test class frame, message decoded
  assert.equal(s.failures[1].message, 'java.lang.NullPointerException: repo was null');
});

test('JUnit: formatted summary is compact and caps failures', () => {
  const s = summarizeTests(parseJUnitXml(fx('junit-fail.xml')));
  const t = formatTestSummary(s, { maxFailures: 1 });
  assert.match(t, /4 run, 1 passed, 2 failed, 1 skipped/);
  assert.match(t, /LoginViewModelTest > empty password is rejected {2}@ LoginViewModelTest\.kt:48/);
  assert.match(t, /\(truncated 1 more\)/);
});

test('findTestLocation skips framework frames', () => {
  const trace = 'at org.junit.Assert.fail(Assert.java:89)\nat com.x.Repo.load(Repo.kt:5)';
  assert.equal(findTestLocation(trace, 'com.x.RepoTest'), 'Repo.kt:5');
});

test('collectTestResults reads only fresh XML under module build dir', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tr-'));
  const dir = path.join(root, 'feature', 'login', 'build', 'test-results', 'testDebugUnitTest');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'TEST-a.xml'), fx('junit-fail.xml'));
  const r = collectTestResults(root, ':feature:login');
  assert.equal(r.files, 1);
  assert.equal(r.summary.failed, 2);
  const stale = collectTestResults(root, ':feature:login', { sinceMs: Date.now() + 60000 });
  assert.equal(stale.files, 0);
});

test('settings parsing: Kotlin DSL, Groovy, multi-line, comments', () => {
  const kts = `rootProject.name = "Acme"\n// include(":ignored")\ninclude(":app", ":core:data")\ninclude(\n  ":feature:login",\n  ":feature:home"\n)\n/* include(":block") */`;
  const k = parseSettings(kts);
  assert.equal(k.rootName, 'Acme');
  assert.deepEqual(k.modules, [':app', ':core:data', ':feature:login', ':feature:home']);
  const g = parseSettings("rootProject.name = 'Old'\ninclude ':app', ':lib'\ninclude ':a',\n    ':b'\ninclude 'plain'");
  assert.deepEqual(g.modules, [':app', ':lib', ':a', ':b', ':plain']);
});

test('classifyBuildFile', () => {
  assert.equal(classifyBuildFile('plugins { id("com.android.application") }'), 'android-app');
  assert.equal(classifyBuildFile('plugins { alias(libs.plugins.android.library) }'), 'android-lib');
  assert.equal(classifyBuildFile('plugins { id("org.jetbrains.kotlin.jvm") }'), 'jvm-lib');
});

test('project overview reads modules and types from disk', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ov-'));
  writeFileSync(path.join(root, 'settings.gradle.kts'), 'rootProject.name = "Acme"\ninclude(":app", ":lib", ":ghost")');
  mkdirSync(path.join(root, 'app')); writeFileSync(path.join(root, 'app', 'build.gradle.kts'), 'plugins { id("com.android.application") }');
  mkdirSync(path.join(root, 'lib')); writeFileSync(path.join(root, 'lib', 'build.gradle'), "plugins { id 'com.android.library' }");
  const o = readProjectOverview(root);
  assert.deepEqual(o.modules.map((m) => m.type), ['android-app', 'android-lib', 'missing-dir']);
  assert.match(formatOverview(o), /Acme: 3 module\(s\)/);
  assert.throws(() => readProjectOverview(mkdtempSync(path.join(tmpdir(), 'none-'))), /No settings/);
});

test('tasks list parsing, filter and cap marker', () => {
  const g = parseTasks(fx('tasks-all.txt'));
  assert.ok(g['Build'].some((t) => t.name === 'assembleDebug'));
  assert.ok(g['Verification'].some((t) => t.name === 'testDebugUnitTest'));
  assert.ok(g['Other'].some((t) => t.name === 'prepareKotlinBuildScriptModel'));
  const f = formatTasks(g, { filter: 'lint' });
  assert.match(f, /2 task\(s\) matching "lint"/);
  assert.match(f, /lintDebug/);
  assert.doesNotMatch(f, /assemble/);
  assert.match(formatTasks(g, { maxTasks: 2 }), /\(truncated \d+ more; pass filter to narrow\)/);
});

test('lint: parse, rank by severity then priority, group by id', () => {
  const issues = parseLintXml(fx('lint-results.xml'));
  assert.equal(issues.length, 5);
  assert.equal(issues[0].line, 12);
  assert.match(issues[3].message, /Hardcoded string "Login"/);
  const ranked = rankLint(issues);
  assert.deepEqual(ranked.map((g) => g.id), ['MissingPermission', 'HardcodedText', 'UnusedResources']);
  assert.equal(ranked[2].count, 2);
  const t = formatLint(issues, { root: '/proj' });
  assert.match(t, /5 issue\(s\) - 1 Error, 3 Warning, 1 Informational/);
  assert.match(t, /1\. \[Error\] MissingPermission x1 @ app\/src\/main\/java\/com\/acme\/Loc\.kt:31/);
  assert.doesNotMatch(t, /GradleDependency/);
  assert.match(formatLint(issues, { maxIssues: 1 }), /\(truncated 2 more\)/);
});

test('dependency conflicts: upgrades, major jumps, unresolved, ignores unversioned/BOM', () => {
  const r = parseDependencyConflicts(fx('deps-tree.txt'));
  const by = Object.fromEntries(r.conflicts.map((c) => [c.key, c]));
  assert.deepEqual(by['org.jetbrains.kotlin:kotlin-stdlib'].requested.sort(), ['1.4.10', '1.9.0']);
  assert.equal(by['org.jetbrains.kotlin:kotlin-stdlib'].resolved, '1.9.24');
  assert.equal(by['com.squareup.okhttp3:okhttp'].majorJump, true);
  assert.equal(by['androidx.annotation:annotation'].requested.length, 2);
  assert.ok(!by['androidx.core:core-ktx']);
  assert.ok(!by['androidx.compose:compose-bom']);
  assert.deepEqual(r.unresolved.map((u) => u.key), ['com.example:ghost']);
  // major jumps sort first
  assert.equal(r.conflicts[0].majorJump, true);
  const t = formatConflicts(r, { maxItems: 2 });
  assert.match(t, /UNRESOLVED com\.example:ghost:1\.0\.0/);
  assert.match(t, /\(truncated \d+ more\)/);
  assert.match(t, /MAJOR jump/);
});

test('capText / capList truncation markers', () => {
  const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const c = capText(big, 200);
  assert.ok(c.length < 260);
  assert.match(c, /\(truncated \d+ more chars\)$/);
  assert.equal(capText('short', 200), 'short');
  assert.deepEqual(capList([1, 2, 3], 2), { items: [1, 2], more: 1 });
});
