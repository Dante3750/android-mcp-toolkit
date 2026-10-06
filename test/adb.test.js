import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDevices, compactUiHierarchy } from '../src/adb.js';

test('parses adb devices -l', () => {
  const out = [
    'List of devices attached',
    'emulator-5554          device product:sdk_gphone64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
    'R58M123ABC            unauthorized transport_id:2',
    '',
  ].join('\n');
  const d = parseDevices(out);
  assert.equal(d.length, 2);
  assert.equal(d[0].serial, 'emulator-5554');
  assert.equal(d[0].state, 'device');
  assert.equal(d[0].model, 'sdk_gphone64_arm64');
  assert.equal(d[1].state, 'unauthorized');
});

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.acme.app" content-desc="" clickable="false" enabled="true" scrollable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Sign in" resource-id="com.acme.app:id/title" class="android.widget.TextView" package="com.acme.app" content-desc="" clickable="false" enabled="true" bounds="[40,200][1040,320]" />
    <node index="1" text="" resource-id="com.acme.app:id/email" class="android.widget.EditText" package="com.acme.app" content-desc="" clickable="true" enabled="true" focused="true" bounds="[40,400][1040,520]" />
    <node index="2" text="Log in &amp; continue" resource-id="com.acme.app:id/login_btn" class="android.widget.Button" package="com.acme.app" content-desc="" clickable="true" enabled="false" bounds="[40,600][1040,720]" />
    <node index="3" text="" resource-id="" class="android.view.View" package="com.acme.app" content-desc="Open menu" clickable="true" enabled="true" bounds="[0,0][120,120]" />
    <node index="4" text="" resource-id="" class="android.view.View" package="com.acme.app" content-desc="" clickable="false" enabled="true" bounds="[0,0][50,50]" />
    <node index="5" text="Hidden" resource-id="" class="android.widget.TextView" package="com.acme.app" content-desc="" clickable="false" enabled="true" bounds="[0,0][0,0]" />
  </node>
</hierarchy>`;

test('compacts the UI hierarchy and keeps only meaningful nodes', () => {
  const r = compactUiHierarchy(XML);
  assert.equal(r.package, 'com.acme.app');
  assert.equal(r.count, 4, 'layout containers, empty views and zero-size nodes are dropped');
  assert.match(r.text, /TextView "Sign in" #title @\(540,260\)/);
  assert.match(r.text, /EditText #email \[click,focused\] @\(540,460\)/);
  assert.match(r.text, /Button "Log in & continue" #login_btn \[click,disabled\] @\(540,660\)/);
  assert.match(r.text, /View "Open menu" \[click\] @\(60,60\)/);
});

test('interactiveOnly keeps just actionable elements', () => {
  const r = compactUiHierarchy(XML, { interactiveOnly: true });
  assert.equal(r.count, 3);
  assert.ok(!/Sign in/.test(r.text));
});

test('compact text is much smaller than the XML', () => {
  assert.ok(compactUiHierarchy(XML).text.length < XML.length / 2);
});
