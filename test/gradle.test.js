import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseGradleOutput, formatGradleResult, runGradle, findGradleWrapper } from '../src/gradle.js';

const fixture = readFileSync(new URL('./fixtures/gradle-failure.txt', import.meta.url), 'utf8');

test('parses outcome, duration and failed tasks', () => {
  const r = parseGradleOutput(fixture);
  assert.equal(r.outcome, 'FAILED');
  assert.equal(r.duration, '14s');
  assert.ok(r.failedTasks.includes(':app:compileDebugKotlin'));
});

test('extracts Kotlin and Java errors with locations and de-duplicates', () => {
  const r = parseGradleOutput(fixture);
  const kotlin = r.errors.filter((e) => e.kind === 'kotlin');
  assert.equal(kotlin.length, 2, 'duplicate Kotlin error should collapse');
  assert.equal(kotlin[0].line, 42);
  assert.equal(kotlin[0].column, 17);
  assert.match(kotlin[0].file, /Home\.kt$/);
  assert.match(kotlin[0].message, /Unresolved reference: fooBar/);

  const java = r.errors.find((e) => e.kind === 'java');
  assert.ok(java);
  assert.equal(java.line, 7);
  assert.equal(java.context, 'Foo f = new Foo();');
});

test('groups warnings and counts duplicates', () => {
  const r = parseGradleOutput(fixture);
  assert.equal(r.warningCount, 5);
  const gradleWarn = r.warnings.find((w) => /buildconfig/.test(w.message));
  assert.equal(gradleWarn.count, 2);
});

test('captures the "What went wrong" block', () => {
  const r = parseGradleOutput(fixture);
  assert.match(r.whatWentWrong[0], /compileDebugKotlin/);
});

test('formatted output is far smaller than raw output and keeps the key facts', () => {
  const r = parseGradleOutput(fixture);
  const out = formatGradleResult(r);
  assert.ok(out.length < fixture.length, 'should be shorter');
  assert.match(out, /BUILD FAILED in 14s/);
  assert.match(out, /Home\.kt:42:17/);
  assert.match(out, /Repo\.kt:10:5/);
});

test('strips ANSI colour codes', () => {
  const r = parseGradleOutput('\u001b[31me: file:///a/B.kt:1:2 Boom\u001b[0m\nBUILD FAILED in 1s');
  assert.equal(r.errors[0].message, 'Boom');
});

test('successful build', () => {
  const r = parseGradleOutput('> Task :app:assembleDebug\n\nBUILD SUCCESSFUL in 3s\n');
  assert.equal(r.outcome, 'SUCCESSFUL');
  assert.equal(r.errorCount, 0);
});

test('test failures are reported', () => {
  const r = parseGradleOutput('com.acme.FooTest > bar FAILED\n    java.lang.AssertionError\nBUILD FAILED in 2s');
  assert.equal(r.errors[0].kind, 'test');
});

test('runGradle executes a wrapper script and filters its output', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fakeproj-'));
  const wrapper = path.join(dir, 'gradlew');
  writeFileSync(wrapper, `#!/bin/sh\ncat <<'EOF'\n${fixture}\nEOF\nexit 1\n`);
  chmodSync(wrapper, 0o755);

  const sub = path.join(dir, 'app');
  assert.equal(findGradleWrapper(sub).root, dir, 'wrapper is found by walking up from a subdirectory');
  const res = await runGradle({ projectDir: dir, tasks: ['assembleDebug'] });
  assert.equal(res.exitCode, 1);
  assert.equal(res.parsed.outcome, 'FAILED');
  assert.equal(res.parsed.errors.length, 3);
});
