import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { condenseLogcat, formatLogcat, parseLogLine } from '../src/logcat.js';

const raw = readFileSync(new URL('./fixtures/logcat-sample.txt', import.meta.url), 'utf8');

test('parses a threadtime line', () => {
  const e = parseLogLine('10-07 01:00:00.100  4321  4321 I MainActivity: onCreate');
  assert.deepEqual(e, { time: '10-07 01:00:00.100', pid: '4321', tid: '4321', level: 'I', tag: 'MainActivity', msg: 'onCreate' });
  assert.equal(parseLogLine('--------- beginning of main'), null);
});

test('filters to the app pid', () => {
  const r = condenseLogcat(raw, { pid: '4321', minLevel: 'D', appPackage: 'com.acme.app' });
  assert.ok(!r.lines.some((l) => l.tag === 'OtherApp'));
});

test('collapses repeated heartbeat lines into one with a count', () => {
  const r = condenseLogcat(raw, { pid: '4321', minLevel: 'D', appPackage: 'com.acme.app' });
  const hb = r.lines.filter((l) => l.tag === 'Sync');
  assert.equal(hb.length, 1);
  assert.equal(hb[0].count, 4);
});

test('respects minLevel', () => {
  const r = condenseLogcat(raw, { pid: '4321', minLevel: 'W', appPackage: 'com.acme.app' });
  assert.ok(r.lines.every((l) => ['W', 'E', 'F'].includes(l.level)));
  assert.ok(!r.lines.some((l) => l.tag === 'MainActivity'));
});

test('extracts the crash with exception, root cause and app frames first', () => {
  const r = condenseLogcat(raw, { pid: '4321', minLevel: 'I', appPackage: 'com.acme.app' });
  assert.equal(r.crashes.length, 1);
  const c = r.crashes[0];
  assert.equal(c.process, 'com.acme.app');
  assert.match(c.exception, /IllegalStateException: Fragment not attached/);
  assert.match(c.rootCause, /NullPointerException: feed was null/);
  assert.ok(c.appFrames.every((f) => f.includes('com.acme')));
  assert.match(c.appFrames[0], /FeedFragment\.render\(FeedFragment\.kt:88\)/);
});

test('crash lines are not repeated in the normal log lines', () => {
  const r = condenseLogcat(raw, { pid: '4321', minLevel: 'I', appPackage: 'com.acme.app' });
  assert.ok(!r.lines.some((l) => l.tag === 'AndroidRuntime'));
});

test('ANRs are surfaced', () => {
  const r = condenseLogcat(raw, { minLevel: 'I' });
  assert.equal(r.anrs.length, 1);
  assert.match(r.anrs[0].message, /ANR in com\.other\.app/);
});

test('formatted output is much shorter than raw and leads with the crash', () => {
  const r = condenseLogcat(raw, { pid: '4321', minLevel: 'I', appPackage: 'com.acme.app' });
  const out = formatLogcat(r);
  assert.match(out, /CRASH at 10-07 01:00:05\.000 in com\.acme\.app/);
  assert.match(out, /root cause: java\.lang\.NullPointerException/);
  assert.ok(out.indexOf('CRASH') < out.indexOf('OkHttp'));
});

test('maxLines keeps warnings and errors, drops older low-priority lines', () => {
  const noisy = [];
  for (let i = 0; i < 200; i++) noisy.push(`10-07 01:01:${String(i % 60).padStart(2, '0')}.000  1  1 I Tag${i}: message number-unique-${'x'.repeat(i % 7)}${i}`);
  noisy.push('10-07 01:02:00.000  1  1 E Boom: the important error');
  const r = condenseLogcat(noisy.join('\n'), { pid: '1', minLevel: 'I', maxLines: 20 });
  assert.ok(r.shownLines <= 20);
  assert.ok(r.lines.some((l) => l.tag === 'Boom'));
  assert.ok(r.truncated > 0);
});
