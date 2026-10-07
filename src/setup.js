// `setup`: ONE command that wires this server into every AI agent found on the machine.
//   npx -y github:Dante3750/android-mcp-toolkit setup
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { SERVER_NAME, PACKAGE_SPEC, serverEntry, readJsonSafe } from './init.js';

/** User-level (global) targets, so it works in every Android project, not just the current folder. */
export function agents({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const claudeDesktop = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : platform === 'win32' ? path.join(appData, 'Claude', 'claude_desktop_config.json')
      : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  const has = (...p) => existsSync(path.join(home, ...p));
  return [
    { id: 'claude-code', label: 'Claude Code', kind: 'claude-cli', detect: () => has('.claude') || has('.claude.json') || onPath('claude') },
    { id: 'claude-desktop', label: 'Claude Desktop', kind: 'json', key: 'mcpServers', file: claudeDesktop, detect: () => existsSync(path.dirname(claudeDesktop)) },
    { id: 'cursor', label: 'Cursor', kind: 'json', key: 'mcpServers', file: path.join(home, '.cursor', 'mcp.json'), detect: () => has('.cursor') },
    { id: 'windsurf', label: 'Windsurf', kind: 'json', key: 'mcpServers', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), detect: () => has('.codeium', 'windsurf') },
    { id: 'gemini', label: 'Gemini CLI', kind: 'json', key: 'mcpServers', file: path.join(home, '.gemini', 'settings.json'), detect: () => has('.gemini') },
    { id: 'codex', label: 'OpenAI Codex CLI', kind: 'toml', file: path.join(home, '.codex', 'config.toml'), detect: () => has('.codex') },
    { id: 'opencode', label: 'opencode', kind: 'opencode', file: path.join(home, '.config', 'opencode', 'opencode.json'), detect: () => has('.config', 'opencode') },
  ];
}

function onPath(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0;
}

const tomlBlock = (entry) =>
  `\n[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;

export function mergeToml(text, entry) {
  if (new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]`, 'm').test(text)) return { status: 'unchanged', text };
  return { status: 'added', text: `${text.replace(/\s*$/, '')}\n${tomlBlock(entry)}` };
}

export function mergeOpencode(doc, entry) {
  const out = doc && typeof doc === 'object' ? structuredClone(doc) : {};
  out.mcp = out.mcp && typeof out.mcp === 'object' ? out.mcp : {};
  const want = { type: 'local', command: [entry.command, ...entry.args], enabled: true };
  if (out.mcp[SERVER_NAME] && JSON.stringify(out.mcp[SERVER_NAME]) === JSON.stringify(want)) return { status: 'unchanged', json: out };
  out.mcp[SERVER_NAME] = want;
  return { status: 'added', json: out };
}

function writeSafe(file, content, existed) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existed) copyFileSync(file, `${file}.bak`);
  writeFileSync(file, content);
}

export function runSetup(argv = [], { home = os.homedir(), platform = process.platform, env = process.env, log = console.log, run = spawnSync } = {}) {
  const dry = argv.includes('--dry-run');
  const only = argv.find((a) => a.startsWith('--agent='))?.split('=')[1];
  const all = agents({ home, platform, env });
  if (only && !all.some((a) => a.id === only)) { log(`Unknown agent "${only}". Choose: ${all.map((a) => a.id).join(', ')}`); return 2; }
  const targets = only ? all.filter((a) => a.id === only) : all.filter((a) => a.detect());
  if (!targets.length) {
    log('No supported AI agent found. Supported: ' + all.map((a) => a.label).join(', '));
    log(`Manual: claude mcp add ${SERVER_NAME} -- npx -y ${PACKAGE_SPEC}`);
    return 1;
  }
  const entry = serverEntry(platform);
  let code = 0;
  log(`${dry ? '[dry run] ' : ''}Setting up android-mcp-toolkit for: ${targets.map((t) => t.label).join(', ')}\n`);
  for (const t of targets) {
    try {
      if (t.kind === 'claude-cli') {
        const cmd = ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', ...[entry.command, ...entry.args]];
        if (dry) { log(`- ${t.label}: would run  claude ${cmd.join(' ')}`); continue; }
        const r = run('claude', cmd, { encoding: 'utf8' });
        if (r.status === 0) log(`- ${t.label}: added (user scope)`);
        else if (/already exists/i.test(`${r.stderr}${r.stdout}`)) log(`- ${t.label}: already configured`);
        else { log(`- ${t.label}: could not run the claude CLI. Run manually:  claude ${cmd.join(' ')}`); code = 1; }
        continue;
      }
      if (t.kind === 'toml') {
        const existed = existsSync(t.file);
        const m = mergeToml(existed ? readFileSync(t.file, 'utf8') : '', entry);
        if (m.status === 'unchanged') { log(`- ${t.label}: already configured`); continue; }
        if (dry) { log(`- ${t.label}: would append to ${t.file}`); continue; }
        writeSafe(t.file, m.text, existed);
        log(`- ${t.label}: wrote ${t.file}`);
        continue;
      }
      const r = readJsonSafe(t.file);
      if (!r.ok) { log(`- ${t.label}: ${t.file} is not plain JSON; add the server by hand (see README)`); code = 1; continue; }
      let m;
      if (t.kind === 'opencode') m = mergeOpencode(r.data, entry);
      else {
        const doc = structuredClone(r.data);
        doc[t.key] = doc[t.key] && typeof doc[t.key] === 'object' ? doc[t.key] : {};
        if (JSON.stringify(doc[t.key][SERVER_NAME]) === JSON.stringify(entry)) m = { status: 'unchanged', json: doc };
        else { doc[t.key][SERVER_NAME] = entry; m = { status: 'added', json: doc }; }
      }
      if (m.status === 'unchanged') { log(`- ${t.label}: already configured`); continue; }
      if (dry) { log(`- ${t.label}: would update ${t.file}`); continue; }
      writeSafe(t.file, `${JSON.stringify(m.json, null, 2)}\n`, r.existed);
      log(`- ${t.label}: wrote ${t.file}${r.existed ? ' (backup: .bak)' : ''}`);
    } catch (e) { log(`- ${t.label}: failed (${e.message})`); code = 1; }
  }
  log('\nRestart your agent, then ask it: "build my Android app and show me any errors".');
  log('Check your machine any time:  npx -y ' + PACKAGE_SPEC + ' doctor');
  return code;
}
