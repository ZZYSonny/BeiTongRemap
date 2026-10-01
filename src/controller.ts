import { frame, modelFor, parseMap, patchMap, readMapParameters, validateSlot } from './protocol.ts';
import type { Model, SourceKey } from './protocol.ts';
import { BLOCKS, BLOCK_COMMANDS, copyBlocks, parseSettings, patchSettings, sameBytes } from './advanced.ts';
import type { SettingsBlocks, SettingsEdits } from './advanced.ts';
import { parseInput } from './input.ts';
import type { ControllerInput } from './input.ts';

export interface Snapshot { slot: number; map: number[]; model: Model }
export interface AdvancedSnapshot extends Snapshot { blocks: SettingsBlocks }
interface Pending { command: number; resolve: (data: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
export class Controller {
  readonly model: Model;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  private busy = false;
  private snapshot?: Snapshot;
  private advancedSnapshot?: AdvancedSnapshot;
  private lastWrite = -Infinity;
  private writeQueue: Promise<void> = Promise.resolve();
  private inputReportId = 3;
  private inputState?: ControllerInput;
  get input(): ControllerInput | undefined { return this.inputState; }
  constructor(readonly device: HIDDevice, private log: (message: string) => void = () => {}) {
    this.model = modelFor(device.vendorId, device.productId);
  }
  async open(): Promise<Snapshot> {
    if (!this.device.opened) await this.device.open();
    const reports = this.device.collections.flatMap(function flatten(c): HIDCollectionInfo[] { return [c, ...(c.children ?? []).flatMap(flatten)]; });
    const size = (report: HIDReportInfo) => (report.items ?? []).reduce((n, item) => n + (item.reportSize ?? 0) * (item.reportCount ?? 0), 0);
    const outputs = reports.flatMap(c => c.outputReports ?? []);
    const inputs = reports.flatMap(c => c.inputReports ?? []);
    const output = outputs.find(r => r.reportId === 2 && size(r) === 63 * 8);
    // A1N3 BFM receivers declare input 2, unlike the vendor app's input-3
    // registration. Their separate gamepad interface also uses ID 3, but
    // with a short input-only report. Match both ID and payload size.
    const inputIds = this.model.relay ? [3, 2] : [3];
    const input = inputIds.map(id => inputs.find(r => r.reportId === id && size(r) === 63 * 8)).find(Boolean);
    if (!output || !input) {
      await this.device.close();
      const describe = (list: HIDReportInfo[]) => [...new Set(list.map(r => `${r.reportId}: ${size(r) / 8} bytes`))].join(', ') || 'none';
      throw new Error(`The HID reports do not match the configuration protocol (input ${inputIds.join(' or ')} / output 2, 63 bytes each). Found input [${describe(inputs)}], output [${describe(outputs)}]. Choose the configuration HID interface.`);
    }
    this.inputReportId = input.reportId!;
    this.device.addEventListener('inputreport', this.onInput);
    try {
      const snapshot = await this.read();
      this.heartbeat = setInterval(() => {
        if (!this.closed && !this.busy && !this.pending.size) void this.send(frame(0, 0, [], this.model.relay)).catch(error => this.fail(new Error(String(error))));
      }, 750);
      return snapshot;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private onInput = (event: HIDInputReportEvent): void => {
    if (event.reportId !== this.inputReportId || event.data.byteLength < 3) return;
    // WebHID excludes the report ID. Preserve DataView offsets.
    let bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength).slice();
    if (this.model.relay) {
      if (bytes[0] !== 0x90 || bytes.length < 4) return;
      bytes = bytes.slice(1);
    }
    if (bytes[2] === 0x11) {
      const input = parseInput(bytes);
      // Show physical controls once raw events are available; interleaved
      // mapped events must not make a remapped backkey flicker onto LS/RS.
      if (input && (input.kind === 'raw' || this.inputState?.kind !== 'raw')) this.inputState = input;
      return;
    }
    const id = bytes[0] | (bytes[1] << 8);
    // Base info is also an unsolicited notification (vendor getBaseInfo has
    // no callback). Only use a fresh notification while a base-info read is
    // pending; writes and all other reads still require their request ID.
    const pendingId = id === 0 && bytes[2] === 0x10
      ? [...this.pending].find(([, request]) => request.command === 0x10)?.[0]
      : id;
    if (pendingId === undefined) return;
    const request = this.pending.get(pendingId);
    // SET_KEYMAP may answer with GET_KEYMAP's opcode and the full resulting
    // map (observed on A1N3 BFM). Keep the request ID mandatory and validate
    // the slot, size and every echoed mapping byte in apply().
    if (!request || (bytes[2] !== request.command && !(request.command === 0x23 && bytes[2] === 0x22))) return;
    clearTimeout(request.timer);
    this.pending.delete(pendingId);
    request.resolve(bytes);
  };
  private fail(error: Error): void {
    this.inputState = undefined;
    this.snapshot = undefined;
    this.advancedSnapshot = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.log(error.message);
  }
  private send(packet: Uint8Array<ArrayBuffer>): Promise<void> {
    const write = this.writeQueue.then(async () => {
      // The recent vendor app sets SetHidWriteDelay(30).
      const remaining = 30 - (performance.now() - this.lastWrite);
      if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, remaining));
      if (this.closed || !this.device.opened) throw new Error('Controller disconnected. Reconnect the receiver and read its settings.');
      this.lastWrite = performance.now();
      await this.device.sendReport(2, packet);
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }
  private async command(command: number, parameters: number[] = []): Promise<Uint8Array> {
    if (this.closed || !this.device.opened) throw new Error('Controller disconnected. Reconnect and read its settings.');
    const id = this.nextRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Controller did not reply to command 0x${command.toString(16)}. Reconnect the receiver, reenter configuration mode, and read its settings again.`));
      }, 2000);
      this.pending.set(id, { command, resolve, reject, timer });
      this.send(frame(id, command, parameters, this.model.relay)).catch(error => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  private nextRequestId(): number {
    this.sequence++;
    if (this.sequence === 8) this.sequence++;
    if (this.sequence >= 0xffff) this.sequence = 1;
    return this.sequence;
  }
  private async currentSlot(): Promise<number> {
    const info = await this.command(0x10);
    if (info.length < 9) throw new Error('Incomplete controller base information.');
    validateSlot(info[3]);
    return info[3];
  }
  async read(): Promise<Snapshot> {
    if (this.busy) throw new Error('A controller operation is already in progress.');
    this.busy = true;
    this.snapshot = undefined;
    this.advancedSnapshot = undefined;
    try {
      const slot = await this.currentSlot();
      const response = await this.command(0x22, readMapParameters(this.model, slot));
      const map = parseMap(response, this.model, slot);
      this.snapshot = { slot, map, model: this.model };
      this.log(`Read ${this.model.keymapSize} keymap bytes from controller slot ${slot}.`);
      return { ...this.snapshot, map: [...map] };
    } finally { this.busy = false; }
  }
  async apply(edits: Partial<Record<SourceKey, number>>): Promise<Snapshot> {
    if (this.busy) throw new Error('A controller operation is already in progress.');
    if (!this.snapshot) throw new Error('Read controller settings before applying a profile.');
    this.busy = true;
    const baseline = this.snapshot;
    this.snapshot = undefined;
    this.advancedSnapshot = undefined;
    let wrote = false;
    let saved = false;
    try {
      if (await this.currentSlot() !== baseline.slot) throw new Error('The active controller slot changed. Read its settings again.');
      const current = parseMap(await this.command(0x22, readMapParameters(this.model, baseline.slot)), this.model, baseline.slot);
      if (current.some((b, i) => b !== baseline.map[i])) throw new Error('Controller settings changed since the last read. Read them again before applying.');
      const next = patchMap(current, this.model, edits);
      wrote = true;
      const response = await this.command(0x23, [...readMapParameters(this.model, baseline.slot), ...next]);
      const echo = parseMap(response, this.model, baseline.slot, response[2] === 0x22 ? 0x22 : 0x23);
      if (echo.some((b, i) => b !== next[i])) throw new Error('Controller write echo does not match the requested keymap.');
      if (await this.currentSlot() !== baseline.slot) throw new Error('The active slot changed during the write.');
      await this.command(this.model.saveCommand, [baseline.slot]);
      saved = true;
      const readback = parseMap(await this.command(0x22, readMapParameters(this.model, baseline.slot)), this.model, baseline.slot);
      if (readback.some((b, i) => b !== next[i])) throw new Error('Controller readback does not match the requested keymap.');
      this.snapshot = { slot: baseline.slot, map: readback, model: this.model };
      this.log(`Controller acknowledged save and verified slot ${baseline.slot}. Power-cycle to verify persistence.`);
      return { ...this.snapshot, map: [...readback] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(wrote ? `${reason} ${saved ? 'A save command was acknowledged; persistence is unverified.' : 'The live mapping may have changed; permanent save was not confirmed.'} Read settings again.` : reason);
    } finally { this.busy = false; }
  }
  private async readBlocks(slot: number): Promise<SettingsBlocks> {
    const blocks = {} as SettingsBlocks;
    for (const block of BLOCKS) blocks[block] = parseSettings(await this.command(BLOCK_COMMANDS[block][0], [slot]), this.model, block, slot);
    return blocks;
  }
  async readAdvanced(): Promise<AdvancedSnapshot> {
    if (this.busy) throw new Error('A controller operation is already in progress.');
    this.busy = true;
    this.snapshot = undefined;
    this.advancedSnapshot = undefined;
    try {
      const slot = await this.currentSlot();
      const map = parseMap(await this.command(0x22, readMapParameters(this.model, slot)), this.model, slot);
      const blocks = await this.readBlocks(slot);
      if (await this.currentSlot() !== slot) throw new Error('The active controller slot changed. Read its settings again.');
      this.snapshot = { slot, map, model: this.model };
      this.advancedSnapshot = { ...this.snapshot, blocks };
      return { ...this.advancedSnapshot, map: [...map], blocks: copyBlocks(blocks) };
    } finally { this.busy = false; }
  }
  async applyAdvanced(edits: SettingsEdits): Promise<AdvancedSnapshot> {
    if (this.busy) throw new Error('A controller operation is already in progress.');
    const baseline = this.advancedSnapshot;
    if (!baseline) throw new Error('Read advanced settings before applying changes.');
    // Reject unsupported fields/ranges before issuing any device commands.
    patchSettings(baseline.blocks, this.model, baseline.slot, edits);
    this.busy = true;
    this.snapshot = undefined;
    this.advancedSnapshot = undefined;
    let wrote = false;
    let saved = false;
    try {
      if (await this.currentSlot() !== baseline.slot) throw new Error('The active controller slot changed. Read its settings again.');
      const map = parseMap(await this.command(0x22, readMapParameters(this.model, baseline.slot)), this.model, baseline.slot);
      const current = await this.readBlocks(baseline.slot);
      if (!sameBytes(map, baseline.map) || BLOCKS.some(block => !sameBytes(current[block], baseline.blocks[block]))) throw new Error('Controller settings changed since the last read. Read them again before applying.');
      const next = patchSettings(current, this.model, baseline.slot, edits);
      const changed = BLOCKS.filter(block => !sameBytes(current[block], next[block]));
      if (!changed.length) throw new Error('No advanced changes to apply.');
      if (await this.currentSlot() !== baseline.slot) throw new Error('The active slot changed before the write.');
      for (const block of changed) {
        wrote = true;
        // Vendor setters check acknowledgement, not a guaranteed full-block echo.
        // command() correlates ID/opcode; the following GETs verify slot/content.
        await this.command(BLOCK_COMMANDS[block][1], [baseline.slot, ...next[block]]);
      }
      const live = await this.readBlocks(baseline.slot);
      if (BLOCKS.some(block => !sameBytes(live[block], next[block]))) throw new Error('Advanced settings readback does not match; save stopped.');
      if (await this.currentSlot() !== baseline.slot) throw new Error('The active slot changed during the write.');
      if (!sameBytes(parseMap(await this.command(0x22, readMapParameters(this.model, baseline.slot)), this.model, baseline.slot), map)) throw new Error('Button mappings changed during the advanced write; save stopped.');
      await this.command(this.model.saveCommand, [baseline.slot]);
      saved = true;
      const blocks = await this.readBlocks(baseline.slot);
      const readbackMap = parseMap(await this.command(0x22, readMapParameters(this.model, baseline.slot)), this.model, baseline.slot);
      if (BLOCKS.some(block => !sameBytes(blocks[block], next[block])) || !sameBytes(readbackMap, map)) throw new Error('Saved settings readback does not match.');
      if (await this.currentSlot() !== baseline.slot) throw new Error('The active slot changed after saving.');
      this.snapshot = { slot: baseline.slot, map: readbackMap, model: this.model };
      this.advancedSnapshot = { ...this.snapshot, blocks };
      return { ...this.advancedSnapshot, map: [...readbackMap], blocks: copyBlocks(blocks) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(wrote ? `${reason} ${saved ? 'A save command was acknowledged; persistence is unverified.' : 'Live settings may have changed; permanent save was not confirmed.'} Read settings again.` : reason);
    } finally { this.busy = false; }
  }
  async disconnect(): Promise<void> {
    if (this.busy) throw new Error('A controller operation is already in progress.');
    this.busy = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      if (this.model.relay && !this.closed && this.device.opened) {
        // third/gen3/gen3.js exitConfigMode calls enableConfig(1) twice.
        // axl2pro_ns_gzt3.js encodes it as 80 03 01, through relay 90.
        // Do not wait for replies: leaving BFM can remove this HID interface.
        await this.send(frame(this.nextRequestId(), 0x80, [0x03, 0x01], true));
        await this.send(frame(this.nextRequestId(), 0x80, [0x03, 0x01], true));
      }
    } finally {
      try { await this.close(); } finally { this.busy = false; }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.device.removeEventListener('inputreport', this.onInput);
    this.fail(new Error('Controller connection closed.'));
    if (this.device.opened) await this.device.close();
  }
}
