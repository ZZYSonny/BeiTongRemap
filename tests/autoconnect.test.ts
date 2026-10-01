import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoConnectTrigger, grantedReceiver, waitForGrantedReceiver } from '../src/autoconnect.ts';
import { switchReceiver } from '../src/receiver.ts';

test('auto trigger recognizes a receiver button press once, and rearms on release or unplug', () => {
  const trigger = new AutoConnectTrigger();
  const button = { pressed: false };
  const pad = { index: 0, id: 'BEITONG A1N3 XINPUT', buttons: [button] } as unknown as Gamepad;
  const other = { index: 1, id: 'Unrelated gamepad', buttons: [{ pressed: true }] } as unknown as Gamepad;
  assert.equal(trigger.poll([pad, other]), undefined);
  button.pressed = true;
  assert.equal(trigger.poll([pad, other]), pad);
  assert.equal(trigger.poll([pad]), undefined);
  button.pressed = false;
  trigger.poll([pad]);
  button.pressed = true;
  assert.equal(trigger.poll([pad]), pad);
  trigger.poll([]);
  assert.equal(trigger.poll([pad]), pad);
  trigger.reset();
  assert.equal(trigger.poll([pad]), pad);
});

test('automatic HID selection excludes input-only interfaces and refuses ambiguous receivers', () => {
  const receiver = { vendorId: 0x20bc, productId: 0x507f, collections: [{ usagePage: 0xff, outputReports: [{ reportId: 2 }] }] } as HIDDevice;
  const gamepad = { ...receiver, collections: [{ usagePage: 1, outputReports: [] }] } as unknown as HIDDevice;
  const unrelated = { ...receiver, vendorId: 0x1234 } as HIDDevice;
  assert.equal(grantedReceiver([gamepad, unrelated]), undefined);
  assert.equal(grantedReceiver([gamepad, receiver, unrelated]), receiver);
  assert.throws(() => grantedReceiver([receiver, { ...receiver } as HIDDevice]), /More than one/);
});

test('disabling auto mode cancels discovery after an in-flight permission lookup', async () => {
  const session = new AbortController();
  const hid = { getDevices: async () => { session.abort(); return []; } } as unknown as HID;
  await assert.rejects(waitForGrantedReceiver(hid, session.signal, 2500), { name: 'AbortError' });
});

test('cancelling an automatic switch stops the remaining symbols and resets rumble', async () => {
  const session = new AbortController();
  let effects = 0, resets = 0;
  await assert.rejects(switchReceiver({
    playEffect: async () => { effects++; return 'complete'; },
    reset: async () => { resets++; return 'complete'; },
  }, async () => { session.abort(); }, session.signal), { name: 'AbortError' });
  assert.equal(effects, 1);
  assert.equal(resets, 1);
});
