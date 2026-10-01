import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT, DISABLED, MODELS, SOURCE_KEYS, frame, modelFor, parseMap, patchMap, readMapParameters } from '../src/protocol.ts';
import { validateProfile } from '../src/profiles.ts';
import { RECEIVER_SEQUENCE, isXboxReceiver, switchReceiver } from '../src/receiver.ts';

test('vendor commands have little-endian request IDs and a separate HID report ID', () => {
  const model = modelFor(0x20bc, 0x507e);
  const data = frame(0x1234, 0x22, readMapParameters(model, 1));
  assert.equal(data.length, 63);
  assert.deepEqual(Array.from(data.slice(0, 6)), [0x34, 0x12, 0x22, 0, 33, 1]);
  assert.deepEqual(Array.from(frame(1, 0x22, [0, 33, 1], true).slice(0, 7)), [0x90, 1, 0, 0x22, 0, 33, 1]);
  assert.throws(() => frame(8, 0));
  assert.throws(() => frame(1, 0x23, Array(64).fill(0)));
});
test('variants select their own map size and persist command; unknown hardware fails closed', () => {
  assert.equal(modelFor(0x20bc, 0x504c).saveCommand, 0xf1);
  assert.equal(modelFor(0x20bc, 0x505c).keymapSize, 33);
  assert.equal(modelFor(0x20bc, 0x507f).relay, true);
  assert.throws(() => modelFor(0x045e, 0x028e));
  assert.throws(() => modelFor(0x20bc, 0x511b)); // Ambiguous firmware family, deliberately excluded.
});
test('button patches preserve existing macros, sensor mappings, and reversed M positions', () => {
  const model = MODELS[3];
  const original = Array.from({ length: 33 }, (_, i) => i + 100);
  original[9] = 0xfe;
  const result = patchMap(original, model, { M1: 0, M2: 1, A: DISABLED });
  assert.equal(SOURCE_KEYS[19], 'M2');
  assert.equal(result[19], 1);
  assert.equal(result[20], 0);
  assert.equal(result[9], 0xfe);
  assert.equal(result[0], DISABLED);
  assert.deepEqual(result.slice(21), original.slice(21));
  assert.equal(original[20], 120);
  assert.throws(() => patchMap([], model, { A: 1 }));
  assert.throws(() => patchMap(original, model, { A: 0xfe }));
});
test('wrong slot, opcode, length, or block cannot be accepted as a readback', () => {
  const model = MODELS[0];
  const data = frame(1, 0x22, [0, 21, 2, ...Array(21).fill(DEFAULT)]);
  assert.deepEqual(parseMap(data, model, 2), Array(21).fill(DEFAULT));
  assert.throws(() => parseMap(data, model, 1));
  assert.throws(() => parseMap(data.slice(0, 10), model, 2));
  assert.throws(() => parseMap(data, model, 2, 0x23));
  data[3] = 1;
  assert.throws(() => parseMap(data, model, 2));
});
test('profile imports reject unsafe values and malformed documents', () => {
  assert.deepEqual(validateProfile({ version: 1, name: '<script>layout</script>', mappings: { A: 1 } }).mappings, { A: 1 });
  for (const value of [null, {}, { version: 1, name: 'test', mappings: [] }, { version: 1, name: 'test', mappings: { A: 1.5 } }, { version: 1, name: 'test', mappings: { A: 0xfe } }, { version: 1, name: 'test', mappings: { unknown: 0 } }]) assert.throws(() => validateProfile(value));
});
test('receiver handshake uses exact high bytes without inter-symbol reset', async () => {
  const calls: string[] = [];
  const bytes: number[][] = [];
  await switchReceiver({
    playEffect: async (type, p) => { assert.equal(type, 'dual-rumble'); assert.equal(p.duration, 1000); const left = Math.trunc(p.strongMagnitude * 65535); const right = Math.trunc(p.weakMagnitude * 65535); assert.equal(left & 255, 0); assert.equal(right & 255, 0); bytes.push([left >> 8, right >> 8]); calls.push('effect'); return 'preempted'; },
    reset: async () => { calls.push('reset'); return 'complete'; },
  }, async ms => { assert.equal(ms, 50); calls.push('delay'); });
  assert.deepEqual(bytes, RECEIVER_SEQUENCE);
  assert.deepEqual(bytes, [
    [0, 0], [1, 6], [5, 3], [2, 4], [0, 0],
    [0, 0], [2, 1], [6, 5], [8, 3], [0, 0], [0, 0], [9, 243], [198, 5], [0, 0],
  ]);
  assert.deepEqual(calls, [...RECEIVER_SEQUENCE.flatMap(() => ['effect', 'delay']), 'reset']);
  assert.equal(isXboxReceiver('Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)'), true);
  assert.equal(isXboxReceiver('Unrelated gamepad'), false);
});
