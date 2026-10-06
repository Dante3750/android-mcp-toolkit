import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);

export function adbBinary() {
  if (process.env.ADB_PATH) return process.env.ADB_PATH;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  return sdk ? path.join(sdk, 'platform-tools', 'adb') : 'adb';
}

/** Run an adb command. `serial` selects a device when several are attached. */
export async function adb(args, { serial, timeoutMs = 30000, encoding = 'utf8', maxBuffer = 64 * 1024 * 1024 } = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  try {
    const { stdout, stderr } = await execFileP(adbBinary(), full, { timeout: timeoutMs, encoding, maxBuffer });
    return { stdout, stderr };
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('adb not found. Install Android platform-tools, or set ADB_PATH / ANDROID_HOME.');
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`adb ${full.join(' ')} failed: ${msg}`);
  }
}

export function parseDevices(out) {
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const props = Object.fromEntries(rest.map((kv) => kv.split(':')).filter((p) => p.length === 2));
      return { serial, state, model: props.model, device: props.device, transport: props.transport_id };
    });
}

export async function listDevices() {
  const { stdout } = await adb(['devices', '-l']);
  return parseDevices(stdout);
}

export async function installApk(apkPath, { serial, replace = true, grantPermissions = true } = {}) {
  const args = ['install'];
  if (replace) args.push('-r');
  if (grantPermissions) args.push('-g');
  args.push(apkPath);
  const { stdout } = await adb(args, { serial, timeoutMs: 180000 });
  return stdout.trim();
}

export async function launchApp(pkg, { serial, activity } = {}) {
  if (activity) {
    const { stdout } = await adb(['shell', 'am', 'start', '-n', `${pkg}/${activity}`], { serial });
    return stdout.trim();
  }
  // monkey launches the default LAUNCHER activity without needing its name
  const { stdout } = await adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], { serial });
  return stdout.trim();
}

export async function stopApp(pkg, { serial } = {}) {
  await adb(['shell', 'am', 'force-stop', pkg], { serial });
  return `stopped ${pkg}`;
}

export async function clearAppData(pkg, { serial } = {}) {
  const { stdout } = await adb(['shell', 'pm', 'clear', pkg], { serial });
  return stdout.trim();
}

export async function tap(x, y, { serial } = {}) {
  await adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))], { serial });
}

export async function swipe(x1, y1, x2, y2, durationMs = 300, { serial } = {}) {
  await adb(['shell', 'input', 'swipe', ...[x1, y1, x2, y2].map((n) => String(Math.round(n))), String(durationMs)], { serial });
}

/** Type text. adb `input text` needs spaces as %s and shell metacharacters escaped. */
export async function typeText(text, { serial } = {}) {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '%s')
    .replace(/(["'`$&|;<>()*?#~!^\[\]{}])/g, '\\$1');
  await adb(['shell', 'input', 'text', escaped], { serial });
}

const KEYS = { back: 4, home: 3, enter: 66, recents: 187, delete: 67, tab: 61, menu: 82 };
export async function pressKey(name, { serial } = {}) {
  const code = KEYS[name.toLowerCase()] ?? name;
  await adb(['shell', 'input', 'keyevent', String(code)], { serial });
}

/** Dump the UI hierarchy via uiautomator and return the raw XML. */
export async function dumpUiXml({ serial } = {}) {
  // /dev/tty prints the XML to stdout on most devices; fall back to a file pull
  try {
    const { stdout } = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { serial, timeoutMs: 30000 });
    const start = stdout.indexOf('<?xml');
    const end = stdout.lastIndexOf('</hierarchy>');
    if (start !== -1 && end !== -1) return stdout.slice(start, end + '</hierarchy>'.length);
  } catch { /* fall through */ }
  await adb(['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'], { serial });
  const { stdout } = await adb(['exec-out', 'cat', '/sdcard/window_dump.xml'], { serial });
  return stdout;
}

function decodeXml(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#10;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
}

function attrs(tag) {
  const o = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) o[m[1]] = decodeXml(m[2]);
  return o;
}

/**
 * Turn a uiautomator XML dump into compact text an agent can act on.
 * Keeps only nodes that carry meaning (text, content-desc, resource-id, or interactive)
 * and prints a tap point (center of bounds) so the agent can call `tap` directly.
 */
export function compactUiHierarchy(xml, { interactiveOnly = false } = {}) {
  const nodes = [];
  for (const m of xml.matchAll(/<node\b[^>]*?\/?>/g)) {
    const a = attrs(m[0]);
    const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue;

    const interactive = a.clickable === 'true' || a.checkable === 'true' || a.scrollable === 'true' || a['long-clickable'] === 'true' || /EditText/.test(a.class || '');
    const hasLabel = !!(a.text || a['content-desc']);
    const hasId = !!a['resource-id'];
    if (!(hasLabel || interactive || (hasId && !interactiveOnly))) continue;
    if (interactiveOnly && !interactive) continue;

    const shortClass = (a.class || '').split('.').pop();
    const id = (a['resource-id'] || '').replace(/^.*:id\//, '');
    const flags = [];
    if (a.clickable === 'true') flags.push('click');
    if (a['long-clickable'] === 'true') flags.push('long');
    if (a.scrollable === 'true') flags.push('scroll');
    if (a.checkable === 'true') flags.push(a.checked === 'true' ? 'checked' : 'unchecked');
    if (a.enabled === 'false') flags.push('disabled');
    if (a.focused === 'true') flags.push('focused');
    if (a.password === 'true') flags.push('password');

    nodes.push({
      cls: shortClass,
      label: a.text || a['content-desc'] || '',
      id,
      flags,
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2),
      area: (x2 - x1) * (y2 - y1),
      pkg: a.package,
    });
  }

  const pkg = nodes.find((n) => n.pkg)?.pkg;
  const lines = nodes.map((n, i) => {
    const label = n.label ? ` "${n.label.length > 80 ? n.label.slice(0, 77) + '...' : n.label}"` : '';
    const id = n.id ? ` #${n.id}` : '';
    const fl = n.flags.length ? ` [${n.flags.join(',')}]` : '';
    return `${i + 1}. ${n.cls}${label}${id}${fl} @(${n.cx},${n.cy})`;
  });
  return { package: pkg, count: nodes.length, text: (pkg ? `app: ${pkg}\n` : '') + lines.join('\n') };
}

export async function screenshotPng({ serial } = {}) {
  const { stdout } = await adb(['exec-out', 'screencap', '-p'], { serial, encoding: 'buffer', timeoutMs: 30000 });
  return Buffer.from(stdout);
}

export async function getPid(pkg, { serial } = {}) {
  try {
    const { stdout } = await adb(['shell', 'pidof', pkg], { serial });
    const pid = stdout.trim().split(/\s+/)[0];
    return pid || null;
  } catch {
    return null;
  }
}

export async function currentFocus({ serial } = {}) {
  const { stdout } = await adb(['shell', 'dumpsys', 'window'], { serial, timeoutMs: 20000 });
  const m = stdout.match(/mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^ }]+)\}/);
  return m ? m[1] : null;
}

export async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'android-mcp-'));
}
export { readFile };
