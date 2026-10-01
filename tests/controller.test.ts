import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.ts';
import { DEFAULT, frame } from '../src/protocol.ts';

class FakeHid extends EventTarget {
  opened = false;
  vendorId = 0x20bc;
  productId = 0x507f;
  productName = 'Fake A1N3 receiver';
  collections = [{ children: [], outputReports: [{ reportId: 2, items: [{ reportSize: 8, reportCount: 63 }] }], inputReports: [{ reportId: 3, items: [{ reportSize: 8, reportCount: 63 }] }] }];
  map: number[] = Array(33).fill(DEFAULT);
  commands: number[] = [];
  slot = 1;
  corrupt = false;
  saved = false;
  inputReportId = 3;
  baseInfoNotification = false;
  sendUnrelatedReports = false;
  keymapWriteReply = 0x23;
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendReport(reportId: number, packet: Uint8Array) {
    assert.equal(reportId, 2);
    assert.equal(packet[0], 0x90);
    const data = packet.slice(1);
    const id = data[0] | (data[1] << 8);
    const command = data[2];
    this.commands.push(command);
    if (!id) return;
    let params: number[] = [];
    if (command === 0x10) params = [this.slot, 5, 1, 100, 0, 0];
    if (command === 0x22 || command === 0x23) {
      if (command === 0x23) this.map = Array.from(data.slice(6, 39));
      const echo = [...this.map];
      if (this.corrupt && command === 0x23) echo[0] = 2;
      params = [0, 33, this.slot, ...echo];
    }
    if (command === 0xa0) this.saved = true;
    const replyCommand = command === 0x23 ? this.keymapWriteReply : command;
    const reply = frame(this.baseInfoNotification && command === 0x10 ? 0 : id, replyCommand, params, true);
    // DataView starts inside a larger allocation to exercise real browser offsets.
    const backing = new Uint8Array(70); backing.set(reply, 4);
    queueMicrotask(() => {
      if (this.sendUnrelatedReports) {
        // A gamepad report with the same request bytes must not complete a
        // configuration read. Neither may an uncorrelated keymap packet.
        for (const [reportId, requestId] of [[3, id], [this.inputReportId, 0]]) {
          if (command === 0x10) continue;
          const wrong = frame(requestId, replyCommand, [0, 33, 1, ...Array(33).fill(0)], true);
          const event = new Event('inputreport');
          Object.assign(event, { reportId, data: new DataView(wrong.buffer) });
          this.dispatchEvent(event);
        }
      }
      const event = new Event('inputreport');
      Object.assign(event, { reportId: this.inputReportId, data: new DataView(backing.buffer, 4, 63) });
      this.dispatchEvent(event);
    });
  }
}
test('receiver write reads first, checks conflicts, saves, and verifies a full map', async () => {
  const device = new FakeHid(); device.map[9] = 0xfe; device.map[21] = 17;
  const controller = new Controller(device as unknown as HIDDevice);
  try {
    await controller.open();
    const result = await controller.apply({ A: 1, M1: 0 });
    assert.deepEqual(device.commands, [0x10, 0x22, 0x10, 0x22, 0x23, 0x10, 0xa0, 0x22]);
    assert.equal(result.map[0], 1); assert.equal(result.map[20], 0);
    assert.equal(result.map[9], 0xfe); assert.equal(result.map[21], 17);
    assert.equal(device.saved, true);
  } finally { await controller.close(); }
});
test('BFM receiver uses input 2, ID-zero base info and a 0x22 keymap-write reply through save', async () => {
  const device = new FakeHid();
  device.collections[0].inputReports = [
    { reportId: 3, items: [{ reportSize: 8, reportCount: 10 }] },
    { reportId: 2, items: [{ reportSize: 8, reportCount: 63 }] },
  ];
  device.inputReportId = 2;
  device.baseInfoNotification = true;
  device.sendUnrelatedReports = true;
  device.keymapWriteReply = 0x22;
  const controller = new Controller(device as unknown as HIDDevice);
  try {
    assert.deepEqual((await controller.open()).map, Array(33).fill(DEFAULT));
    const result = await controller.apply({ A: 1 });
    assert.equal(result.map[0], 1);
    assert.equal(result.map[1], DEFAULT);
    assert.equal(device.saved, true);
    device.slot = 2;
    await assert.rejects(controller.apply({ A: 0 }), /slot changed/);
  } finally { await controller.close(); }
});
test('input-only BFM gamepad interface is rejected with descriptor details', async () => {
  const device = new FakeHid();
  device.collections[0].outputReports = [];
  device.collections[0].inputReports[0].items[0].reportCount = 10;
  const controller = new Controller(device as unknown as HIDDevice);
  await assert.rejects(controller.open(), /Found input \[3: 10 bytes\], output \[none\]/);
  assert.equal(device.opened, false);
  assert.deepEqual(device.commands, []);
});
test('configuration input is separate from command replies and clears on close', async () => {
  const device = new FakeHid();
  const controller = new Controller(device as unknown as HIDDevice);
  const emit = (kind: number, bits: number, reportId = 3, relay = 0x90) => {
    const data = frame(0, 0x11, [kind, 128, 128, 128, 128, 0, 0, bits & 255, bits >>> 8 & 255, bits >>> 16 & 255, 0], true);
    data[0] = relay;
    const event = new Event('inputreport');
    Object.assign(event, { reportId, data: new DataView(data.buffer) });
    device.dispatchEvent(event);
  };
  try {
    await controller.open();
    emit(0, 1);
    assert.equal(controller.input?.buttons.A, true);
    emit(1, 1 << 20);
    assert.equal(controller.input?.buttons.M1, true);
    emit(0, 1 << 12); // Mapped RS must not replace the physical backkey.
    emit(1, 1 << 19, 2); // Wrong report ID.
    emit(1, 1 << 19, 3, 0x91); // Wrong relay.
    emit(2, 1 << 19); // Unknown event subtype.
    assert.equal(controller.input?.buttons.M1, true);
    assert.equal(controller.input?.buttons.M2, false);
    assert.equal(controller.input?.buttons.RS, false);
    await controller.apply({ A: 1 });
    assert.equal(controller.input?.buttons.M1, true);
    emit(1, 0);
    assert.equal(controller.input?.buttons.M1, false);
  } finally { await controller.close(); }
  assert.equal(controller.input, undefined);
});
test('changed active slot prevents any mapping write', async () => {
  const device = new FakeHid(); const controller = new Controller(device as unknown as HIDDevice);
  try { await controller.open(); device.slot = 2; await assert.rejects(controller.apply({ A: 1 }), /slot changed/); assert.equal(device.commands.includes(0x23), false); }
  finally { await controller.close(); }
});
test('external edit prevents overwrite and requires a fresh read', async () => {
  const device = new FakeHid(); const controller = new Controller(device as unknown as HIDDevice);
  try {
    await controller.open(); device.map[0] = 2;
    await assert.rejects(controller.apply({ A: 1 }), /settings changed/);
    await assert.rejects(controller.apply({ A: 1 }), /Read controller/);
    assert.equal(device.saved, false);
    await controller.read(); await controller.apply({ A: 1 }); assert.equal(device.saved, true);
  } finally { await controller.close(); }
});
for (const opcode of [0x23, 0x22]) test(`corrupt 0x${opcode.toString(16)} write response stops permanent save and reports possible live changes`, async () => {
  const device = new FakeHid(); device.keymapWriteReply = opcode;
  const controller = new Controller(device as unknown as HIDDevice);
  try { await controller.open(); device.corrupt = true; await assert.rejects(controller.apply({ A: 1 }), /live mapping may have changed/); assert.equal(device.saved, false); }
  finally { await controller.close(); }
});
test('descriptor mismatch closes the device before issuing commands', async () => {
  const device = new FakeHid(); device.collections[0].outputReports[0].items[0].reportCount = 64;
  const controller = new Controller(device as unknown as HIDDevice);
  await assert.rejects(controller.open(), /HID reports/);
  assert.equal(device.opened, false); assert.deepEqual(device.commands, []);
});
