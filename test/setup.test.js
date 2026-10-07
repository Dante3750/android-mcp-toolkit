import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetup, mergeToml, mergeOpencode } from '../src/setup.js';

const mk = () => { const h = mkdtempSync(path.join(os.tmpdir(), 'setup-')); return h; };
const quiet = () => { const out = []; return { log: (s) => out.push(s), out }; };

test('setup configures every detected agent and keeps other servers', () => {
  const home = mk();
  mkdirSync(path.join(home, '.cursor'), { recursive: true });
  writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  mkdirSync(path.join(home, '.gemini'), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "o4"\n');
  mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  const q = quiet();
  const code = runSetup([], { home, platform: 'linux', env: {}, log: q.log, run: () => ({ status: 0 }) });
  assert.equal(code, 0);
  const cursor = JSON.parse(readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cursor.mcpServers.other && cursor.mcpServers.android.command === 'npx');
  assert.ok(existsSync(path.join(home, '.cursor', 'mcp.json.bak')));
  assert.equal(JSON.parse(readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8')).mcpServers.android.args[1], 'github:Dante3750/android-mcp-toolkit');
  const toml = readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /model = "o4"/); assert.match(toml, /\[mcp_servers\.android\]/);
  const oc = JSON.parse(readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(oc.mcp.android.type, 'local');
});

test('setup is idempotent and dry-run writes nothing', () => {
  const home = mk(); mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const q = quiet();
  runSetup(['--dry-run', '--agent=gemini'], { home, platform: 'linux', env: {}, log: q.log });
  assert.ok(!existsSync(path.join(home, '.gemini', 'settings.json')));
  runSetup(['--agent=gemini'], { home, platform: 'linux', env: {}, log: q.log });
  const q2 = quiet(); runSetup(['--agent=gemini'], { home, platform: 'linux', env: {}, log: q2.log });
  assert.match(q2.out.join('\n'), /already configured/);
});

test('claude code uses the claude CLI at user scope', () => {
  const home = mk(); const calls = []; const q = quiet();
  runSetup(['--agent=claude-code'], { home, platform: 'linux', env: {}, log: q.log, run: (c, a) => { calls.push([c, ...a]); return { status: 0 }; } });
  assert.deepEqual(calls[0].slice(0, 5), ['claude', 'mcp', 'add', '--scope', 'user']);
});

test('nothing detected and unknown agent give nonzero codes; toml/opencode merges are idempotent', () => {
  const q = quiet();
  
  assert.equal(runSetup(['--agent=nope'], { home: mk(), log: q.log }), 2);
  const e = { command: 'npx', args: ['-y', 'x'] };
  const t = mergeToml('', e); assert.equal(mergeToml(t.text, e).status, 'unchanged');
  const o = mergeOpencode({}, e); assert.equal(mergeOpencode(o.json, e).status, 'unchanged');
});
