import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput } from '../src/input.ts';

test('captured configuration notifications decode backkeys and releases', () => {
  // Actual A1N3 packets captured on October 1, HID ID 2 / relay 90 removed.
  const backing = Buffer.from('aabb0000110180808080000000000800cc', 'hex');
  const input = parseInput(backing.subarray(2, -1))!;
  assert.equal(input.kind, 'raw');
  assert.equal(input.buttons.M2, true);
  assert.equal(input.buttons.M1, false);
  assert.deepEqual(input.axes.map(value => value || 0), [0, 0, 0, 0]);
  assert.deepEqual(input.triggers, [0, 0]);
  const released = parseInput(Buffer.from('0000110180808080000000000000', 'hex'))!;
  assert.equal(Object.values(released.buttons).some(Boolean), false);
});

test('configuration input decodes axes, analog triggers and independent button bits', () => {
  const input = parseInput(Uint8Array.from([0, 0, 0x11, 0, 0, 0, 255, 255, 64, 255, 1, 0, 20, 0]))!;
  assert.deepEqual(input.axes, [1, -1, -1, 1]);
  assert.deepEqual(input.triggers, [64 / 255, 1]);
  assert.equal(input.buttons.A, true);
  assert.equal(input.buttons.M1, true);
  assert.equal(input.buttons.M2, false);
  assert.equal(input.buttons.LT, false);
  assert.equal(input.buttons.RT, true);
});

test('short, non-input and unknown input subtypes are ignored', () => {
  assert.equal(parseInput(new Uint8Array(13)), undefined);
  assert.equal(parseInput(Uint8Array.from([0, 0, 0x22, 1, ...Array(10).fill(0)])), undefined);
  assert.equal(parseInput(Uint8Array.from([0, 0, 0x11, 2, ...Array(10).fill(0)])), undefined);
});
