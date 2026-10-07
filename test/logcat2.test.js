import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { condenseLogcat, formatLogcat, sinceCutoff, lastLogTime, parseLogTime } from '../src/logcat.js';

const raw = readFileSync(new URL('./fixtures/logcat-sample.txt', import.meta.url), 'utf8');

test('sinceCutoff subtracts ms and handles midnight/month rollover', () => {
  assert.equal(sinceCutoff('10-07 01:00:03.000', 1000), '10-07 01:00:02.000');
  assert.equal(sinceCutoff('10-07 00:00:00.500', 1000), '10-06 23:59:59.500');
  assert.equal(sinceCutoff('03-01 00:00:00.000', 1000), '02-29 23:59:59.000'); // fixed leap year is fine for ordering
  assert.equal(sinceCutoff('garbage', 5), undefined);
  assert.equal(parseLogTime('nope'), null);
});

test('lastLogTime finds the newest timestamp', () => {
  assert.match(lastLogTime(raw), /^10-07 01:00:\d\d\.\d{3}$/);
  assert.equal(lastLogTime('no logs'), undefined);
});

test('sinceTime drops older entries', () => {
  const all = condenseLogcat(raw, { pid: '4321', minLevel: 'D', appPackage: 'com.acme.app' });
  const recent = condenseLogcat(raw, { pid: '4321', minLevel: 'D', appPackage: 'com.acme.app', sinceTime: '10-07 01:00:02.350' });
  assert.ok(recent.matchedLines < all.matchedLines);
  assert.ok(!recent.lines.some((l) => l.tag === 'MainActivity'));
  assert.ok(recent.lines.some((l) => l.tag === 'Repo'));
});

test('tags filter keeps only requested tag', () => {
  const r = condenseLogcat(raw, { pid: '4321', minLevel: 'V', tags: ['Repo'], appPackage: 'com.acme.app' });
  assert.ok(r.lines.length > 0);
  assert.ok(r.lines.every((l) => l.tag === 'Repo'));
});

test('lines cap keeps errors and long messages are clipped', () => {
  const long = `10-07 01:00:09.000  4321  4321 I Big: ${'x'.repeat(2000)}`;
  const r = condenseLogcat(`${raw}\n${long}`, { pid: '4321', minLevel: 'D', maxLines: 3, appPackage: 'com.acme.app' });
  assert.equal(r.shownLines, 3, 'hard cap honoured');
  assert.ok(r.truncated > 0 && r.lines.every((l) => l.level === 'E' || l.level === 'W'), 'low-priority dropped first, most recent errors kept');
  const text = formatLogcat(condenseLogcat(long, { minLevel: 'I' }));
  assert.ok(text.length < 600, 'long message clipped');
});
