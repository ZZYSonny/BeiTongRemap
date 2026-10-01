// Independently implemented from the supplied 20260922 vendor archive.
// See docs/protocol.md for source locations and evidence boundaries.
export const SOURCE_KEYS = [
  'A', 'B', 'X', 'Y', 'Back', 'Start', 'Turbo', 'Shift', 'Home',
  // Wire order: byte 19 is the left backkey (M2), byte 20 the right (M1).
  // Diagram positions and preset targets must not change these device offsets.
  'LB', 'RB', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'LT', 'RT', 'M2', 'M1',
] as const;
export type SourceKey = typeof SOURCE_KEYS[number];
export const TARGET_KEYS = [
  ...SOURCE_KEYS.slice(0, 19),
  'L ↑', 'L ↗', 'L →', 'L ↘', 'L ↓', 'L ↙', 'L ←', 'L ↖',
  'R ↑', 'R ↗', 'R →', 'R ↘', 'R ↓', 'R ↙', 'R ←', 'R ↖',
];
export const DEFAULT = 0xff;
export const DISABLED = 0xfd;
export const MACRO = 0xfe;
export interface Model {
  productId: number;
  name: string;
  keymapSize: number;
  saveCommand: number;
  reloadCommand: number;
  source: string;
  relay?: boolean;
}
export const MODELS: readonly Model[] = [
  { productId: 0x504c, name: 'Asura 2 Pro · wired', keymapSize: 21, saveCommand: 0xf1, reloadCommand: 0xf5, source: 'axl2pro_new.js' },
  { productId: 0x505b, name: 'Asura 2 Pro · wireless', keymapSize: 21, saveCommand: 0xf1, reloadCommand: 0xf5, source: 'axl2prow_new.js' },
  { productId: 0x505c, name: 'Asura 2 Pro · multi-mode', keymapSize: 33, saveCommand: 0xa0, reloadCommand: 0xa4, source: 'axl2pro_ns.js' },
  { productId: 0x507e, name: 'Asura 2 Pro+ · A1N3', keymapSize: 33, saveCommand: 0xa0, reloadCommand: 0xa4, source: 'axl2pro_ns_gzt3.js' },
  { productId: 0x507f, name: 'Asura 2 Pro+ · wireless receiver', keymapSize: 33, saveCommand: 0xa0, reloadCommand: 0xa4, source: 'axl2pro_ns_gzt3.js', relay: true },
];
export function modelFor(vendorId: number, productId: number): Model {
  const model = vendorId === 0x20bc ? MODELS.find(m => m.productId === productId) : undefined;
  if (!model) throw new Error('This is not a supported Asura 2 Pro configuration interface. Switch the receiver to configuration mode and choose its BeiTong HID.');
  return model;
}
export function validateSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) throw new Error('Invalid controller slot (expected 1–4).');
}
export function frame(requestId: number, command: number, parameters: readonly number[] = [], relay = false): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(requestId) || requestId < 0 || requestId >= 0xffff || requestId === 8) throw new Error('Invalid request ID.');
  const bytes = [...(relay ? [0x90] : []), requestId & 0xff, requestId >>> 8, command, ...parameters];
  if (bytes.length > 63 || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error('Invalid command frame.');
  const result = new Uint8Array(63);
  result.set(bytes);
  return result;
}
export function readMapParameters(model: Model, slot: number): number[] {
  validateSlot(slot);
  return [0, model.keymapSize, slot];
}
export function parseMap(data: Uint8Array, model: Model, slot: number, command = 0x22): number[] {
  validateSlot(slot);
  if (data.length < 6 + model.keymapSize || data[2] !== command || data[3] !== 0 || data[4] !== model.keymapSize || data[5] !== slot) {
    throw new Error('Controller returned an unexpected keymap response.');
  }
  return Array.from(data.slice(6, 6 + model.keymapSize));
}
export function patchMap(original: readonly number[], model: Model, edits: Partial<Record<SourceKey, number>>): number[] {
  if (original.length !== model.keymapSize || original.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error('Read the controller keymap before writing.');
  const result = [...original];
  for (const [key, value] of Object.entries(edits)) {
    const index = SOURCE_KEYS.indexOf(key as SourceKey);
    if (index < 0 || value === undefined || !Number.isInteger(value) || !(value === DEFAULT || value === DISABLED || (value >= 0 && value < TARGET_KEYS.length))) throw new Error('Invalid button mapping.');
    result[index] = value;
  }
  return result;
}
export function mappingLabel(value: number, source: SourceKey): string {
  if (value === DEFAULT) return `${source} · default`;
  if (value === DISABLED) return 'Disabled';
  if (value === MACRO) return 'Existing macro';
  return TARGET_KEYS[value] ?? `Existing value 0x${value.toString(16).padStart(2, '0')}`;
}
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
}
