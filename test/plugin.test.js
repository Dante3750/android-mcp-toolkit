import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const json = (p) => JSON.parse(rd(p));

test('plugin, marketplace and package versions agree', () => {
  const pkg = json('package.json');
  const plugin = json('.claude-plugin/plugin.json');
  const mp = json('.claude-plugin/marketplace.json');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.name, 'android-mcp-toolkit');
  assert.equal(mp.plugins[0].name, plugin.name, 'entry name must equal manifest name');
  assert.equal(mp.plugins[0].source, './');
  assert.ok(mp.owner.name);
});

test('.mcp.json launches the server via npx from GitHub', () => {
  const s = json('.mcp.json').mcpServers.android;
  assert.equal(s.command, 'npx');
  assert.deepEqual(s.args, ['-y', 'github:Dante3750/android-mcp-toolkit']);
});

test('slash commands and skill have frontmatter descriptions', () => {
  for (const f of readdirSync(new URL('../commands/', import.meta.url))) {
    assert.match(rd(`commands/${f}`), /^---\ndescription: .+\n/, f);
  }
  assert.deepEqual(readdirSync(new URL('../commands/', import.meta.url)).sort(), ['android-build.md', 'android-crash.md', 'android-ui-check.md']);
  assert.match(rd('skills/android-dev-loop/SKILL.md'), /^---\nname: android-dev-loop\ndescription: .+\n---/);
});

test('package is npx-ready: bin shebang, no prepare script, files include src', () => {
  const pkg = json('package.json');
  assert.equal(pkg.bin['android-mcp-toolkit'], 'src/cli.js');
  assert.ok(rd('src/cli.js').startsWith('#!/usr/bin/env node\n'));
  assert.equal(pkg.scripts.prepare, undefined);
  assert.ok(pkg.files.includes('src'));
  assert.ok(existsSync(new URL('../LICENSE', import.meta.url)));
});
