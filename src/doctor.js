// `doctor`: environment checks with fix hints. Checks are injectable for tests.
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { adbBinary, parseDevices } from './adb.js';
import { findGradleWrapper } from './gradle.js';

const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

export function parseJavaVersion(out) {
  const m = out.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return m[1] === '1' ? +m[2] : +m[1]; // "1.8.0" -> 8
}

export async function runChecks({ env = process.env, cwd = process.cwd(), nodeVersion = process.versions.node, exec = run } = {}) {
  const res = [];
  const add = (name, status, detail, fix) => res.push({ name, status, detail, fix });

  const nodeMajor = +nodeVersion.split('.')[0];
  nodeMajor >= 18 ? add('node', 'ok', `v${nodeVersion}`) : add('node', 'fail', `v${nodeVersion}`, 'Install Node 18 or newer (https://nodejs.org).');

  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (!sdk) add('ANDROID_HOME', 'warn', 'not set', 'Set ANDROID_HOME to your SDK (e.g. ~/Android/Sdk or ~/Library/Android/sdk); needed for adb discovery and R8 retrace.');
  else if (!existsSync(sdk)) add('ANDROID_HOME', 'fail', `${sdk} does not exist`, 'Point ANDROID_HOME at the real SDK directory.');
  else add('ANDROID_HOME', 'ok', sdk);

  const adbBin = env.ADB_PATH || (sdk ? path.join(sdk, 'platform-tools', 'adb') : 'adb');
  const v = await exec(adbBin, ['version']);
  let adbOk = false;
  if (v.err) add('adb', 'warn', `cannot run "${adbBin}"`, 'Install Android platform-tools and add it to PATH, or set ANDROID_HOME / ADB_PATH.');
  else { adbOk = true; add('adb', 'ok', (v.stdout.split('\n')[0] || 'found').trim()); }

  if (adbOk) {
    const d = await exec(adbBin, ['devices', '-l']);
    const devs = d.err ? [] : parseDevices(d.stdout);
    const ready = devs.filter((x) => x.state === 'device');
    if (!devs.length) add('devices', 'warn', 'none attached', 'Start an emulator or connect a phone with USB debugging enabled. Gradle tools still work without a device.');
    else if (!ready.length) add('devices', 'warn', devs.map((x) => `${x.serial} ${x.state}`).join(', '), 'Accept the USB debugging prompt on the phone (unauthorized) or wait for the emulator to boot (offline).');
    else add('devices', 'ok', ready.map((x) => `${x.serial}${x.model ? ` (${x.model})` : ''}`).join(', '));
  }

  const gw = findGradleWrapper(cwd);
  if (!gw) add('gradlew', 'warn', `not found at or above ${cwd}`, 'Run doctor from your Android project root, or pass projectDir to the tools.');
  else {
    let exec_ = true;
    try { exec_ = process.platform === 'win32' || (statSync(gw.wrapper).mode & 0o111) !== 0; } catch { /* ignore */ }
    exec_ ? add('gradlew', 'ok', gw.wrapper) : add('gradlew', 'warn', `${gw.wrapper} is not executable`, `chmod +x ${gw.wrapper}`);
  }

  const javaBin = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', 'java') : 'java';
  const j = await exec(javaBin, ['-version']);
  if (j.err) add('java', 'fail', `cannot run "${javaBin}"`, 'Install JDK 17 (AGP 8.x requirement) and set JAVA_HOME, or use the JDK bundled with Android Studio.');
  else {
    const major = parseJavaVersion(j.stderr + j.stdout);
    if (major == null) add('java', 'warn', 'version not recognised');
    else if (major < 17) add('java', 'warn', `JDK ${major}`, 'Modern Android Gradle Plugin (8+) needs JDK 17+. Set JAVA_HOME to a newer JDK.');
    else add('java', 'ok', `JDK ${major}`);
  }
  return res;
}

export function formatChecks(results) {
  const tag = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]' };
  const out = results.map((r) => `${tag[r.status]} ${r.name}: ${r.detail}${r.fix ? `\n       fix: ${r.fix}` : ''}`);
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  out.push(fails ? `\n${fails} problem(s) must be fixed.` : warns ? `\nNo blockers; ${warns} warning(s).` : '\nAll good.');
  return out.join('\n');
}

export async function runDoctor(opts = {}, log = console.log) {
  const r = await runChecks(opts);
  log(formatChecks(r));
  return r.some((x) => x.status === 'fail') ? 1 : 0;
}
