import type { SourceKey } from './protocol.ts';

export interface ControllerInput {
  kind: 'raw' | 'mapped';
  buttons: Partial<Record<SourceKey, boolean>>;
  axes: [number, number, number, number];
  triggers: [number, number];
}

// Physical capture confirms left M2 = bit 19, right M1 = bit 20.
// The vendor's KEY_POS_M1/M2 names are reversed on this controller.
const EVENT_KEYS: readonly SourceKey[] = [
  'A', 'B', 'X', 'Y', 'Back', 'Start', 'Turbo', 'Shift', 'Home',
  'LB', 'RB', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'LT', 'RT', 'M2', 'M1',
];

/** Parse a controller 0x11 notification after stripping HID ID / relay prefix. */
export function parseInput(data: Uint8Array): ControllerInput | undefined {
  if (data.length < 14 || data[2] !== 0x11 || (data[3] !== 0 && data[3] !== 1)) return;
  const bits = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(10, true);
  const buttons = Object.fromEntries(EVENT_KEYS.map((key, bit) => [key, Boolean(bits & (1 << bit))]));
  const triggers: [number, number] = [data[8] / 255, data[9] / 255];
  // Vendor X values run right-to-left; Y runs top-to-bottom. Normalize
  // around 0x80 with exact -1 / 0 / +1 endpoints for the Gamepad renderer.
  const axis = (value: number) => (value - 128) / (value < 128 ? 128 : 127);
  return {
    kind: data[3] === 1 ? 'raw' : 'mapped', buttons, triggers,
    axes: [-axis(data[4]), axis(data[5]), -axis(data[6]), axis(data[7])],
  };
}
