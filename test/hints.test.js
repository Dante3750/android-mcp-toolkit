import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectHints, attachSnippets, parseGradleOutput, formatGradleResult } from '../src/gradle.js';

const ids = (raw) => detectHints(raw).map((h) => h.id);

const CASES = {
  'kotlin-ksp-mismatch': "e: [ksp] ksp-1.9.0-1.0.13 is too old for kotlin-2.0.0. Please upgrade ksp or downgrade kotlin-gradle-plugin to 1.9.0.",
  jdk: "* What went wrong:\nExecution failed for task ':app:compileDebugJavaWithJavac'.\n> Unsupported class file major version 65",
  'missing-sdk': "* What went wrong:\nSDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable",
  'duplicate-class': "Duplicate class kotlin.collections.jdk8.CollectionsJDK8Kt found in modules jetified-kotlin-stdlib-1.8.0 (org.jetbrains.kotlin:kotlin-stdlib:1.8.0) and kotlin-stdlib-jdk8-1.6.0",
  'resolve-network': "Could not resolve all files for configuration ':app:debugRuntimeClasspath'.\n> Could not resolve androidx.core:core:1.12.0.\n   > Could not GET 'https://dl.google.com/dl/android/maven2/androidx/core/core/1.12.0/core-1.12.0.pom'.\n      > Connect timed out",
  'resolve-missing': "> Could not find com.example:nothere:1.0.\n  Searched in the following locations:\n    - https://repo.maven.apache.org/maven2/com/example/nothere/1.0/nothere-1.0.pom\n  Required by:\n      project :app",
  oom: "Expiring Daemon because JVM heap space is exhausted\njava.lang.OutOfMemoryError: Java heap space",
  'r8-missing-rules': "ERROR: R8: Missing class org.slf4j.impl.StaticLoggerBinder (referenced from: void foo.Bar.<clinit>())\nMissing rules written to app/build/outputs/mapping/release/missing_rules.txt",
};

for (const [id, raw] of Object.entries(CASES)) {
  test(`hint: ${id}`, () => {
    const got = ids(raw);
    assert.ok(got.includes(id), `expected ${id}, got ${got}`);
  });
}

test('hint: network failure does not also claim missing repository', () => {
  const got = ids(CASES['resolve-network'] + '\n  Searched in the following locations:\n  Required by: project :app');
  assert.ok(got.includes('resolve-network'));
  assert.ok(!got.includes('resolve-missing'));
});

test('hint: clean output yields none; hints rendered under "Likely cause"', () => {
  assert.deepEqual(detectHints('BUILD SUCCESSFUL in 3s'), []);
  const r = parseGradleOutput('BUILD FAILED in 2s');
  r.hints = detectHints(CASES.oom);
  assert.match(formatGradleResult(r), /Likely cause:\n- Out of memory: add to gradle\.properties: org\.gradle\.jvmargs=-Xmx4g/);
});

test('snippets: 2 lines of context around the error line, relative and absolute paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sn-'));
  const src = Array.from({ length: 10 }, (_, i) => `val line${i + 1} = ${i + 1}`).join('\n');
  writeFileSync(path.join(root, 'A.kt'), src);
  const errors = [
    { kind: 'kotlin', file: 'A.kt', line: 5, message: 'boom' },
    { kind: 'kotlin', file: path.join(root, 'A.kt'), line: 1, message: 'edge' },
    { kind: 'kotlin', file: 'Missing.kt', line: 1, message: 'nofile' },
    { kind: 'kotlin', message: 'noloc' },
  ];
  attachSnippets(errors, root);
  assert.equal(errors[0].snippet.split('\n').length, 5);
  assert.match(errors[0].snippet, /^ {2}3 \| val line3/m);
  assert.match(errors[0].snippet, /^> 5 \| val line5 = 5/m);
  assert.equal(errors[1].snippet.split('\n').length, 3, 'clamped at file start');
  assert.equal(errors[2].snippet, undefined);
  const out = formatGradleResult({ outcome: 'FAILED', duration: null, failedTasks: [], errorCount: 1, errors: [errors[0]], warningCount: 0, uniqueWarnings: 0, warnings: [] });
  assert.match(out, /> 5 \| val line5/);
});

test('error list shows truncation marker', () => {
  const errors = Array.from({ length: 5 }, (_, i) => ({ kind: 'kotlin', file: `F${i}.kt`, line: i + 1, message: `m${i}` }));
  const out = formatGradleResult({ outcome: 'FAILED', duration: null, failedTasks: [], errorCount: 5, errors, warningCount: 0, uniqueWarnings: 0, warnings: [] }, { maxErrors: 2 });
  assert.match(out, /\(truncated 3 more\)/);
});
