import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.ts';
import { BLOCKS, BLOCK_COMMANDS, parseSettings, patchSettings, settingsFor, settingsLayout } from '../src/advanced.ts';
import type { SettingsBlocks } from '../src/advanced.ts';
import { DEFAULT, MODELS, frame, modelFor } from '../src/protocol.ts';

class AdvancedHid extends EventTarget {
  opened = false;
  vendorId = 0x20bc;
  collections = [{ children: [], outputReports: [{ reportId: 2, items: [{ reportSize: 8, reportCount: 63 }] }], inputReports: [{ reportId: 3, items: [{ reportSize: 8, reportCount: 63 }] }] }];
  map: number[];
  blocks: SettingsBlocks;
  commands: number[] = [];
  slot = 1;
  wrongSlot = false;
  corruptWrite = false;
  corruptSave = false;
  raceMap = false;
  saved = false;
  constructor(readonly productId = 0x507f) {
    super();
    const model = modelFor(this.vendorId, productId);
    const layout = settingsLayout(model);
    this.map = Array(model.keymapSize).fill(DEFAULT);
    this.map[9] = 0xfe;
    this.blocks = Object.fromEntries(BLOCKS.map(block => [block, layout[block].map((_, i) => 170 + i)])) as unknown as SettingsBlocks;
    for (const field of settingsFor(model)) this.blocks[field.block][field.index] = field.min;
    for (const side of ['lt', 'rt']) {
      const end = layout.base.indexOf(`${side}_areapro_e`);
      if (end >= 0) this.blocks.base[end] = 100;
    }
  }
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendReport(reportId: number, packet: Uint8Array) {
    assert.equal(reportId, 2); assert.equal(packet.length, 63);
    const model = modelFor(this.vendorId, this.productId);
    if (model.relay) assert.equal(packet[0], 0x90);
    const data = model.relay ? packet.slice(1) : packet;
    const id = data[0] | (data[1] << 8);
    if (!id) return;
    const command = data[2]; this.commands.push(command);
    let params: number[] = [];
    if (command === 0x10) params = [this.slot, 5, 1, 90, 0, 0];
    if (command === 0x22) params = [0, model.keymapSize, this.slot, ...this.map];
    for (const block of BLOCKS) {
      const [read, write] = BLOCK_COMMANDS[block];
      if (command === read) params = [this.wrongSlot ? 2 : this.slot, ...this.blocks[block]];
      if (command === write) {
        assert.equal(data[3], this.slot);
        this.blocks[block] = Array.from(data.slice(4, 4 + this.blocks[block].length));
        if (this.corruptWrite) this.blocks[block][0] ^= 1;
        if (this.raceMap) this.map[0] = 2;
        // Setter response has no assumed block echo or slot.
      }
    }
    if (command === model.saveCommand) { this.saved = true; if (this.corruptSave) this.blocks.left[0] ^= 1; }
    const response = frame(id, command, params, model.relay);
    queueMicrotask(() => { const event = new Event('inputreport'); Object.assign(event, { reportId: 3, data: new DataView(response.buffer) }); this.dispatchEvent(event); });
  }
}
const isWrite = (command: number) => [0x21, 0x27, 0x29, 0xa0, 0xf1].includes(command);

test('advanced layouts match each supplied model and patches preserve hidden settings', () => {
  for (const model of MODELS) {
    const layout = settingsLayout(model);
    assert.equal(layout.base.length, model.productId >= 0x507e ? 21 : model.keymapSize === 33 ? 18 : 9);
    assert.equal(layout.left.length, model.productId >= 0x507e ? 12 : 10);
    const device = new AdvancedHid(model.productId);
    const result = patchSettings(device.blocks, model, 1, { 'base.vib_level_l': 4, 'left.areapro': 15 });
    assert.equal(result.base[4], 4); assert.equal(result.left[0], 15);
    assert.deepEqual(result.base.slice(0, 4), device.blocks.base.slice(0, 4));
    assert.deepEqual(result.left.slice(1), device.blocks.left.slice(1));
    assert.deepEqual(result.right, device.blocks.right);
    assert.throws(() => patchSettings(device.blocks, model, 1, { 'base.led_color': 2 }), /Invalid/);
    assert.throws(() => patchSettings(device.blocks, model, 1, { 'base.vib_level_l': 5 }), /Invalid/);
    assert.throws(() => patchSettings(device.blocks, model, 1, { 'left.areapro': NaN }), /Invalid/);
    const data = frame(1, 0x20, [1, ...device.blocks.base]);
    assert.deepEqual(parseSettings(data, model, 'base', 1), device.blocks.base);
    assert.throws(() => parseSettings(data, model, 'base', 2), /Unexpected/);
    assert.throws(() => parseSettings(data.slice(0, 6), model, 'base', 1), /Unexpected/);
    assert.throws(() => parseSettings(data, model, 'left', 1), /Unexpected/);
  }
});
test('pro settings stay in PC slot 1 and trigger thresholds keep a useful range', () => {
  const device = new AdvancedHid(); const model = modelFor(0x20bc, device.productId);
  assert.throws(() => patchSettings(device.blocks, model, 2, { 'base.performance': 1 }), /PC slot 1/);
  assert.throws(() => patchSettings(device.blocks, model, 2, { 'left.areapro_p': 5 }), /PC slot 1/);
  assert.throws(() => patchSettings(device.blocks, model, 1, { 'base.lt_areapro_s': 20, 'base.lt_areapro_e': 25 }), /10% separation/);
  assert.throws(() => patchSettings(device.blocks, MODELS[0], 1, { 'base.performance': 1 }), /Read advanced/);
});
test('advanced writes across all variants save only changed blocks and preserve mappings', async () => {
  for (const model of MODELS) {
    const device = new AdvancedHid(model.productId); const controller = new Controller(device as unknown as HIDDevice);
    try {
      await controller.open();
      const original = await controller.readAdvanced();
      const map = [...device.map]; const base = [...device.blocks.base]; const left = [...device.blocks.left];
      original.blocks.base[1] = 0; // Consumer mutation must not mutate the baseline.
      const result = await controller.applyAdvanced({ 'base.vib_level_l': 4, 'left.areapro': 8 });
      assert.equal(result.blocks.base[4], 4); assert.equal(result.blocks.left[0], 8);
      assert.equal(device.saved, true);
      assert.deepEqual(device.map, map);
      assert.deepEqual(device.blocks.base.filter((_, i) => i !== 4), base.filter((_, i) => i !== 4));
      assert.deepEqual(device.blocks.left.slice(1), left.slice(1));
      assert.deepEqual(device.commands.filter(isWrite), [0x21, 0x27, model.saveCommand]);
      assert.equal(device.commands.includes(0x23), false);
    } finally { await controller.close(); }
  }
});
test('advanced concurrent edits in another block or the keymap prevent all writes', async () => {
  for (const conflict of ['map', 'right'] as const) {
    const device = new AdvancedHid(); const controller = new Controller(device as unknown as HIDDevice);
    try {
      await controller.open(); await controller.readAdvanced();
      if (conflict === 'map') device.map[0] = 2; else device.blocks.right[3] = 7;
      await assert.rejects(controller.applyAdvanced({ 'base.vib_level_l': 4 }), /settings changed/);
      assert.equal(device.commands.some(isWrite), false);
      await assert.rejects(controller.applyAdvanced({ 'base.vib_level_l': 4 }), /Read advanced/);
      await assert.rejects(controller.apply({ A: 1 }), /Read controller/);
    } finally { await controller.close(); }
  }
});
test('slot changes and malformed reads prevent an advanced write', async () => {
  const device = new AdvancedHid(); const controller = new Controller(device as unknown as HIDDevice);
  try {
    await controller.open(); await controller.readAdvanced(); device.slot = 2;
    await assert.rejects(controller.applyAdvanced({ 'base.vib_level_l': 4 }), /slot changed/);
    assert.equal(device.commands.some(isWrite), false);
    device.slot = 1; device.wrongSlot = true;
    await assert.rejects(controller.readAdvanced(), /Unexpected base/);
    await assert.rejects(controller.applyAdvanced({ 'base.vib_level_l': 4 }), /Read advanced/);
  } finally { await controller.close(); }
});
test('mismatched live readback stops persistence; failed saved readback reports acknowledgement', async () => {
  for (const failure of ['corruptWrite', 'corruptSave'] as const) {
    const device = new AdvancedHid(); const controller = new Controller(device as unknown as HIDDevice);
    try {
      await controller.open(); await controller.readAdvanced(); device[failure] = true;
      await assert.rejects(controller.applyAdvanced({ 'base.vib_level_l': 4 }), failure === 'corruptWrite' ? /Live settings may have changed; permanent save was not confirmed/ : /save command was acknowledged; persistence is unverified/);
      assert.equal(device.saved, failure === 'corruptSave');
      await assert.rejects(controller.applyAdvanced({ 'base.vib_level_l': 4 }), /Read advanced/);
    } finally { await controller.close(); }
  }
});
test('a button map changed during advanced writes stops save without rewriting the map', async () => {
  const device = new AdvancedHid(); const controller = new Controller(device as unknown as HIDDevice);
  try {
    await controller.open(); await controller.readAdvanced(); device.raceMap = true;
    await assert.rejects(controller.applyAdvanced({ 'base.vib_level_l': 4 }), /Button mappings changed during the advanced write/);
    assert.equal(device.saved, false); assert.equal(device.map[0], 2);
    assert.equal(device.commands.includes(0x23), false);
  } finally { await controller.close(); }
});
