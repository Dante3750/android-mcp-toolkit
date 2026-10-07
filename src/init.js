// `init`: detect MCP clients and print / merge the server config without touching other servers.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVER_NAME = 'android';
export const PACKAGE_SPEC = 'github:Dante3750/android-mcp-toolkit';

export function serverEntry(platform = process.platform) {
  const args = ['-y', PACKAGE_SPEC];
  return platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args };
}

/** Client definitions. `key` is the top-level object holding servers in that client's file. */
export function clients({ cwd = process.cwd(), home = os.homedir(), global = false } = {}) {
  return [
    {
      id: 'claude', label: 'Claude Code', key: 'mcpServers', file: path.join(cwd, '.mcp.json'),
      detect: () => existsSync(path.join(home, '.claude')) || existsSync(path.join(home, '.claude.json')) || existsSync(path.join(cwd, '.mcp.json')),
      cli: `claude mcp add ${SERVER_NAME} -- npx -y ${PACKAGE_SPEC}`,
    },
    {
      id: 'cursor', label: 'Cursor', key: 'mcpServers',
      file: global ? path.join(home, '.cursor', 'mcp.json') : path.join(cwd, '.cursor', 'mcp.json'),
      detect: () => existsSync(path.join(home, '.cursor')) || existsSync(path.join(cwd, '.cursor')),
    },
    {
      id: 'vscode', label: 'VS Code', key: 'servers', file: path.join(cwd, '.vscode', 'mcp.json'), typed: true,
      detect: () => existsSync(path.join(cwd, '.vscode')),
    },
    {
      id: 'windsurf', label: 'Windsurf', key: 'mcpServers', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      detect: () => existsSync(path.join(home, '.codeium', 'windsurf')),
    },
  ];
}

/** Pure merge: returns { status, json } where status is added | unchanged | conflict. Never drops other servers. */
export function mergeConfig(existing, client, entry, { force = false } = {}) {
  const doc = existing && typeof existing === 'object' ? structuredClone(existing) : {};
  const want = client.typed ? { type: 'stdio', ...entry } : entry;
  doc[client.key] = doc[client.key] && typeof doc[client.key] === 'object' ? doc[client.key] : {};
  const cur = doc[client.key][SERVER_NAME];
  if (cur && JSON.stringify(cur) === JSON.stringify(want)) return { status: 'unchanged', json: doc };
  if (cur && !force) return { status: 'conflict', json: doc };
  doc[client.key][SERVER_NAME] = want;
  return { status: 'added', json: doc };
}

export function snippet(client, entry) {
  const want = client.typed ? { type: 'stdio', ...entry } : entry;
  return JSON.stringify({ [client.key]: { [SERVER_NAME]: want } }, null, 2);
}

/** Read a JSON file; returns {ok, data}. A missing file is ok with {}; unparseable (e.g. JSONC) is not ok. */
export function readJsonSafe(file) {
  if (!existsSync(file)) return { ok: true, data: {}, existed: false };
  try { return { ok: true, data: JSON.parse(readFileSync(file, 'utf8') || '{}'), existed: true }; } catch (e) { return { ok: false, error: e.message, existed: true }; }
}

export function runInit(argv = [], { cwd = process.cwd(), home = os.homedir(), platform = process.platform, log = console.log } = {}) {
  const write = argv.includes('--write');
  const force = argv.includes('--force');
  const global = argv.includes('--global');
  const only = argv.find((a) => a.startsWith('--client='))?.split('=')[1];
  const all = clients({ cwd, home, global });
  if (only && !all.some((c) => c.id === only)) { log(`Unknown client "${only}". Choose: ${all.map((c) => c.id).join(', ')}`); return 2; }

  let targets = only ? all.filter((c) => c.id === only) : all.filter((c) => c.detect());
  const guessed = !targets.length;
  if (guessed) targets = all;
  log(guessed ? 'No MCP client detected; showing config for all supported clients.' : `Detected: ${targets.map((c) => c.label).join(', ')}`);

  const entry = serverEntry(platform);
  let code = 0;
  for (const c of targets) {
    log(`\n## ${c.label}  (${c.file})`);
    if (c.cli) log(`One-liner: ${c.cli}`);
    if (!write) { log(snippet(c, entry)); continue; }
    const r = readJsonSafe(c.file);
    if (!r.ok) { log(`Skipped: ${c.file} is not plain JSON (${r.error}). Add this by hand:\n${snippet(c, entry)}`); code = 1; continue; }
    const m = mergeConfig(r.data, c, entry, { force });
    if (m.status === 'unchanged') { log('Already configured.'); continue; }
    if (m.status === 'conflict') { log(`A different "${SERVER_NAME}" server already exists; left untouched. Use --force to replace it, or add manually:\n${snippet(c, entry)}`); code = 1; continue; }
    mkdirSync(path.dirname(c.file), { recursive: true });
    if (r.existed) copyFileSync(c.file, `${c.file}.bak`);
    writeFileSync(c.file, `${JSON.stringify(m.json, null, 2)}\n`);
    log(`Wrote ${c.file}${r.existed ? ` (backup: ${c.file}.bak)` : ''}`);
  }
  if (!write) log('\nRe-run with --write to merge this into the files above (other servers are never overwritten).');
  return code;
}
