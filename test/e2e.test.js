import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const FX = new URL('./fixtures/', import.meta.url).pathname;
const CLI = new URL('../src/cli.js', import.meta.url).pathname;
let client, proj, bin;

const sh = (p, body) => writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-'));
  proj = path.join(root, 'proj');
  bin = path.join(root, 'bin');
  mkdirSync(path.join(proj, 'app', 'src', 'main', 'java', 'com', 'acme', 'ui'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(proj, 'settings.gradle.kts'), 'rootProject.name = "Acme"\ninclude(":app")');
  writeFileSync(path.join(proj, 'app', 'build.gradle.kts'), 'plugins { id("com.android.application") }');
  writeFileSync(path.join(proj, 'app', 'src', 'main', 'java', 'com', 'acme', 'ui', 'Home.kt'), Array.from({ length: 9 }, (_, i) => `val l${i + 1} = ${i + 1}`).join('\n'));

  // Fake gradlew: behaves according to the task requested
  sh(path.join(proj, 'gradlew'), `
case "$*" in
  *testDebugUnitTest*)
    d="$(dirname "$0")/app/build/test-results/testDebugUnitTest"; mkdir -p "$d"; cp "${FX}junit-fail.xml" "$d/TEST-x.xml"
    echo "> Task :app:testDebugUnitTest FAILED"; echo "BUILD FAILED in 3s"; exit 1;;
  *lintDebug*)
    d="$(dirname "$0")/app/build/reports"; mkdir -p "$d"; cp "${FX}lint-results.xml" "$d/lint-results-debug.xml"
    echo "BUILD SUCCESSFUL in 2s"; exit 0;;
  *dependencies*) cat "${FX}deps-tree.txt"; exit 0;;
  tasks*) cat "${FX}tasks-all.txt"; exit 0;;
  *) cat "${FX}gradle-failure.txt"; echo "e: file://$(dirname "$0")/app/src/main/java/com/acme/ui/Home.kt:5:3 Snippet probe"; exit 1;;
esac`);

  // Fake adb
  sh(path.join(bin, 'adb'), `
case "$*" in
  "devices -l") printf 'List of devices attached\\nemulator-5554\\tdevice product:sdk model:Pixel_8 device:emu transport_id:1\\n';;
  *pidof*) echo 4321;;
  *date*) echo "10-07 01:00:03.000";;
  *logcat*-d*) cat "${FX}logcat-sample.txt";;
  *) ;;
esac`);

  client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [CLI], env: { ...process.env, ADB_PATH: path.join(bin, 'adb') },
  }));
});

after(async () => { await client?.close(); });

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n') };
};

test('lists all tools with annotations and short descriptions', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ['gradle_build', 'gradle_test', 'gradle_modules', 'gradle_tasks', 'lint_summary', 'gradle_deps_conflicts', 'logcat', 'logcat_clear',
    'android_devices', 'android_install', 'android_launch', 'ui_dump', 'android_tap', 'android_swipe', 'android_type', 'android_screenshot', 'android_current_screen']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  for (const t of tools) {
    assert.ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', `${t.name} annotations`);
    assert.ok(t.description.length <= 300, `${t.name} description too long (${t.description.length})`);
  }
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  assert.equal(by.ui_dump.readOnlyHint, true);
  assert.equal(by.gradle_modules.readOnlyHint, true);
  assert.equal(by.logcat_clear.destructiveHint, true);
  assert.equal(by.android_launch.destructiveHint, true);
  assert.equal(by.gradle_build.readOnlyHint, false);
});

test('android_devices via fake adb', async () => {
  const r = await call('android_devices', {});
  assert.match(r.text, /emulator-5554\s+device\s+Pixel_8/);
});

test('gradle_modules (static, no gradle run)', async () => {
  const r = await call('gradle_modules', { projectDir: proj });
  assert.match(r.text, /Acme: 1 module/);
  assert.match(r.text, /:app {2}android-app/);
});

test('gradle_build returns filtered errors and a non-error-free failure flag', async () => {
  const r = await call('gradle_build', { projectDir: proj, tasks: ['assembleDebug'] });
  assert.equal(r.isError, true);
  assert.match(r.text, /BUILD FAILED/);
  assert.match(r.text, /Unresolved reference: fooBar/);
  assert.match(r.text, /Snippet probe\n\s+ 3 \| val l3 = 3\n\s+ 4 \| val l4 = 4\n\s+> 5 \| val l5 = 5\n\s+ 6 \| val l6 = 6\n\s+ 7 \| val l7 = 7/);
});

test('gradle_test reports counts and failure locations', async () => {
  const r = await call('gradle_test', { projectDir: proj, filter: '*Login*' });
  assert.equal(r.isError, true);
  assert.match(r.text, /4 run, 1 passed, 2 failed, 1 skipped/);
  assert.match(r.text, /@ LoginViewModelTest\.kt:48/);
});

test('lint_summary with run=true', async () => {
  const r = await call('lint_summary', { projectDir: proj, run: true });
  assert.match(r.text, /\[Error\] MissingPermission/);
});

test('gradle_deps_conflicts', async () => {
  const r = await call('gradle_deps_conflicts', { projectDir: proj });
  assert.match(r.text, /okhttp3:okhttp: 3\.12\.0 -> 4\.12\.0 {2}\(MAJOR jump\)/);
});

test('gradle_tasks filters and caches', async () => {
  const a = await call('gradle_tasks', { projectDir: proj, filter: 'lint' });
  assert.match(a.text, /lintDebug/);
  assert.doesNotMatch(a.text, /\(cached\)/);
  const b = await call('gradle_tasks', { projectDir: proj, filter: 'assemble' });
  assert.match(b.text, /assembleDebug/);
  assert.match(b.text, /\(cached\)/);
});

test('logcat with sinceMs, tag and lines via fake adb', async () => {
  const r = await call('logcat', { appPackage: 'com.acme.app', minLevel: 'D', sinceMs: 1000, tag: 'Repo', lines: 20 });
  assert.match(r.text, /Repo: failed to load feed/);
  assert.doesNotMatch(r.text, /MainActivity/);
  assert.doesNotMatch(r.text, /heartbeat/);
});

test('errors are returned as isError, not thrown', async () => {
  const r = await call('gradle_build', { projectDir: '/definitely/not/here', tasks: ['x'] });
  assert.equal(r.isError, true);
  assert.match(r.text, /No gradlew found/);
});
