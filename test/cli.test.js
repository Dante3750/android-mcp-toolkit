import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInit, mergeConfig, clients, serverEntry, SERVER_NAME } from '../src/init.js';
import { runChecks, formatChecks, parseJavaVersion } from '../src/doctor.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const CLI = new URL('../src/cli.js', import.meta.url).pathname;

test('cli --version / --help / unknown', () => {
  const v = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const h = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.match(h.stdout, /init/);
  assert.match(h.stdout, /doctor/);
  const u = spawnSync(process.execPath, [CLI, 'bogus'], { encoding: 'utf8' });
  assert.equal(u.status, 2);
});

test('init detects clients and prints config without writing', () => {
  const cwd = tmp('c-'); const home = tmp('h-');
  mkdirSync(path.join(cwd, '.vscode')); mkdirSync(path.join(home, '.cursor'));
  const out = [];
  const code = runInit([], { cwd, home, platform: 'linux', log: (s) => out.push(s) });
  const t = out.join('\n');
  assert.equal(code, 0);
  assert.match(t, /Detected: Cursor, VS Code/);
  assert.match(t, /"mcpServers"/);
  assert.match(t, /"servers"/);
  assert.match(t, /"type": "stdio"/);
  assert.ok(!existsSync(path.join(cwd, '.vscode', 'mcp.json')), 'nothing written without --write');
});

test('init --write merges and never removes other servers; creates backup', () => {
  const cwd = tmp('c-'); const home = tmp('h-');
  mkdirSync(path.join(cwd, '.cursor'));
  const f = path.join(cwd, '.cursor', 'mcp.json');
  writeFileSync(f, JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } }, extra: 1 }));
  assert.equal(runInit(['--write', '--client=cursor'], { cwd, home, platform: 'linux', log: () => {} }), 0);
  const j = JSON.parse(readFileSync(f, 'utf8'));
  assert.deepEqual(j.mcpServers.other, { command: 'x', args: [] });
  assert.equal(j.extra, 1);
  assert.deepEqual(j.mcpServers[SERVER_NAME], serverEntry('linux'));
  assert.ok(existsSync(`${f}.bak`));
  // idempotent
  const out = [];
  runInit(['--write', '--client=cursor'], { cwd, home, platform: 'linux', log: (s) => out.push(s) });
  assert.match(out.join('\n'), /Already configured/);
});

test('init refuses to overwrite a different "android" server unless --force; refuses invalid JSON', () => {
  const cwd = tmp('c-'); const home = tmp('h-');
  const f = path.join(cwd, '.mcp.json');
  writeFileSync(f, JSON.stringify({ mcpServers: { android: { command: 'mine' } } }));
  const out = [];
  assert.equal(runInit(['--write', '--client=claude'], { cwd, home, log: (s) => out.push(s) }), 1);
  assert.match(out.join('\n'), /left untouched/);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).mcpServers.android.command, 'mine');
  assert.equal(runInit(['--write', '--client=claude', '--force'], { cwd, home, platform: 'linux', log: () => {} }), 0);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).mcpServers.android.command, 'npx');

  const g = path.join(cwd, '.vscode', 'mcp.json');
  mkdirSync(path.dirname(g));
  writeFileSync(g, '{ // comment\n "servers": {} }');
  assert.equal(runInit(['--write', '--client=vscode'], { cwd, home, log: () => {} }), 1);
  assert.match(readFileSync(g, 'utf8'), /comment/, 'unparseable file left intact');
});

test('init: unknown client, windows entry, mergeConfig purity', () => {
  assert.equal(runInit(['--client=nope'], { log: () => {} }), 2);
  assert.equal(serverEntry('win32').command, 'cmd');
  const before = { mcpServers: { a: {} } };
  const c = clients({ cwd: '/x', home: '/h' })[0];
  const m = mergeConfig(before, c, serverEntry('linux'));
  assert.equal(m.status, 'added');
  assert.deepEqual(before, { mcpServers: { a: {} } }, 'input not mutated');
});

test('doctor: all-good, and each failure carries a fix hint', async () => {
  const proj = tmp('p-');
  writeFileSync(path.join(proj, 'gradlew'), '#!/bin/sh\n', { mode: 0o755 });
  const sdk = tmp('sdk-');
  const exec = async (cmd, args) => {
    if (cmd.endsWith('adb') && args[0] === 'version') return { stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '' };
    if (cmd.endsWith('adb')) return { stdout: 'List of devices attached\nemulator-5554\tdevice product:sdk model:Pixel_8 device:emu transport_id:1\n', stderr: '' };
    return { stdout: '', stderr: 'openjdk version "17.0.9" 2023-10-17' };
  };
  const good = await runChecks({ env: { ANDROID_HOME: sdk }, cwd: proj, exec });
  assert.ok(good.every((c) => c.status === 'ok'), JSON.stringify(good));
  assert.match(formatChecks(good), /All good/);

  const bad = await runChecks({
    env: {}, cwd: tmp('empty-'), nodeVersion: '16.0.0',
    exec: async (cmd) => ({ err: new Error('ENOENT'), stdout: '', stderr: '', cmd }),
  });
  const by = Object.fromEntries(bad.map((c) => [c.name, c]));
  assert.equal(by.node.status, 'fail');
  assert.equal(by.adb.status, 'warn');
  assert.equal(by.java.status, 'fail');
  assert.equal(by.gradlew.status, 'warn');
  assert.ok(bad.filter((c) => c.status !== 'ok').every((c) => c.fix), 'every non-ok has a fix');
  assert.match(formatChecks(bad), /must be fixed/);
});

test('doctor: old JDK and unauthorized device warn', async () => {
  assert.equal(parseJavaVersion('openjdk version "1.8.0_292"'), 8);
  assert.equal(parseJavaVersion('java version "21.0.1"'), 21);
  const exec = async (cmd, args) => {
    if (cmd.endsWith('adb') && args[0] === 'version') return { stdout: 'ADB 1', stderr: '' };
    if (cmd.endsWith('adb')) return { stdout: 'List of devices attached\nABC123\tunauthorized transport_id:2\n', stderr: '' };
    return { stdout: '', stderr: 'openjdk version "11.0.2"' };
  };
  const r = Object.fromEntries((await runChecks({ env: {}, cwd: tmp('x-'), exec })).map((c) => [c.name, c]));
  assert.equal(r.java.status, 'warn');
  assert.equal(r.devices.status, 'warn');
  assert.match(r.devices.fix, /USB debugging/);
});
