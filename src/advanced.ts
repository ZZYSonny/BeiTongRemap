import { validateSlot } from './protocol.ts';
import type { Model } from './protocol.ts';

export type Block = 'base' | 'left' | 'right';
export type Category = 'general' | 'sticks' | 'triggers' | 'lighting';
export type SettingsBlocks = Record<Block, number[]>;
export type SettingsEdits = Partial<Record<string, number>>;
export interface Setting {
  id: string; block: Block; index: number; label: string; category: Category;
  min: number; max: number; unit?: string; options?: readonly string[]; pcOnly?: boolean;
}
const BASE_LEGACY = ['led_type', 'led_color', 'led_light', 'led_freq', 'vib_level_l', 'vib_level_r', 'turbo_freq', 'ltrt_areapro', 'autosleep_timeout'];
const BASE_NS = [...BASE_LEGACY.slice(0, 6), 'vib_flash', ...BASE_LEGACY.slice(6), 'lt_areapro_e', 'lt_areapro_s', 'rt_areapro_e', 'rt_areapro_s', 'lt_distance_e', 'lt_distance_s', 'rt_distance_e', 'rt_distance_s'];
const BASE_A1N3 = [...BASE_NS, 'performance', 'trigger_method_l', 'trigger_method_r'];
const STICK = ['areapro', 'sensitivity_change_en', 'sensitivity_change_key', 'sensitivity_type', 'sensitivity_x1', 'sensitivity_y1', 'sensitivity_x2', 'sensitivity_y2', 'sensitivity_x3', 'sensitivity_y3'];
export const BLOCK_COMMANDS: Record<Block, readonly [number, number]> = { base: [0x20, 0x21], left: [0x26, 0x27], right: [0x28, 0x29] };
export const BLOCKS: readonly Block[] = ['base', 'left', 'right'];
export function settingsLayout(model: Model): Record<Block, readonly string[]> {
  const a1n3 = model.productId === 0x507e || model.productId === 0x507f;
  const stick = a1n3 ? [...STICK, 'areapro_p', 'fix_center'] : STICK;
  return { base: a1n3 ? BASE_A1N3 : model.keymapSize === 33 ? BASE_NS : BASE_LEGACY, left: stick, right: stick };
}
export function settingsFor(model: Model): Setting[] {
  const layout = settingsLayout(model);
  const result: Setting[] = [];
  const add = (block: Block, name: string, label: string, category: Category, min: number, max: number, unit?: string, options?: readonly string[], pcOnly = false) => {
    const index = layout[block].indexOf(name);
    if (index >= 0) result.push({ id: `${block}.${name}`, block, index, label, category, min, max, unit, options, pcOnly });
  };
  add('base', 'vib_level_l', 'Left motor', 'general', 0, 4, undefined, ['Off', '25%', '50%', '75%', '100%']);
  add('base', 'vib_level_r', 'Right motor', 'general', 0, 4, undefined, ['Off', '25%', '50%', '75%', '100%']);
  add('base', 'performance', 'Pro mode', 'general', 0, 1, undefined, ['Off', 'On'], true);
  add('base', 'turbo_freq', 'Turbo rate', 'general', 1, 30, '/s');
  add('base', 'autosleep_timeout', 'Sleep after', 'general', 0, 60, 'min · 0 = off');
  for (const block of ['left', 'right'] as const) {
    add(block, 'areapro', 'Deadzone', 'sticks', 0, 100, '%');
    add(block, 'areapro_p', 'Pro deadzone', 'sticks', 0, 100, '%', undefined, true);
  }
  if (layout.base.includes('lt_areapro_s')) {
    for (const side of ['lt', 'rt']) {
      add('base', `${side}_areapro_s`, `${side.toUpperCase()} start`, 'triggers', 0, 90, '%');
      add('base', `${side}_areapro_e`, `${side.toUpperCase()} full press`, 'triggers', 10, 100, '%');
      add('base', `trigger_method_${side === 'lt' ? 'l' : 'r'}`, `${side.toUpperCase()} quick trigger`, 'triggers', 0, 1, undefined, ['Off', 'On']);
    }
  } else add('base', 'ltrt_areapro', 'Trigger deadzone', 'triggers', 0, 100, '%');
  add('base', 'led_type', 'Light effect', 'lighting', 0, 1, undefined, ['Steady', 'Breathing']);
  add('base', 'led_light', 'Brightness', 'lighting', 1, 5, '/ 5');
  add('base', 'led_freq', 'Breathing speed', 'lighting', 1, 5, '/ 5');
  add('base', 'vib_flash', 'Flash with vibration', 'lighting', 0, 1, undefined, ['Off', 'On']);
  return result;
}
export function parseSettings(data: Uint8Array, model: Model, block: Block, slot: number): number[] {
  validateSlot(slot);
  const size = settingsLayout(model)[block].length;
  if (data[2] !== BLOCK_COMMANDS[block][0] || data[3] !== slot || data.length < 4 + size) throw new Error(`Unexpected ${block} settings response.`);
  return Array.from(data.slice(4, 4 + size));
}
export function patchSettings(original: SettingsBlocks, model: Model, slot: number, edits: SettingsEdits): SettingsBlocks {
  validateSlot(slot);
  const layout = settingsLayout(model);
  const result = {} as SettingsBlocks;
  for (const block of BLOCKS) {
    if (original[block]?.length !== layout[block].length || original[block].some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error('Read advanced settings before writing.');
    result[block] = [...original[block]];
  }
  const fields = settingsFor(model);
  for (const [id, value] of Object.entries(edits)) {
    const field = fields.find(f => f.id === id);
    if (!field) throw new Error('Invalid or unsupported advanced setting.');
    if (value === undefined || !Number.isInteger(value) || value < field.min || value > field.max) throw new Error(`Invalid ${field.label.toLowerCase()}: use a whole number from ${field.min} to ${field.max}.`);
    if (field.pcOnly && slot !== 1) throw new Error('Pro mode settings are available in PC slot 1.');
    result[field.block][field.index] = value;
  }
  for (const side of ['lt', 'rt']) {
    const start = layout.base.indexOf(`${side}_areapro_s`);
    const end = layout.base.indexOf(`${side}_areapro_e`);
    if (start >= 0 && (Object.hasOwn(edits, `base.${side}_areapro_s`) || Object.hasOwn(edits, `base.${side}_areapro_e`)) && result.base[end] - result.base[start] < 10) throw new Error(`${side.toUpperCase()} start and full press need at least 10% separation.`);
  }
  return result;
}
export function sameBytes(a: readonly number[], b: readonly number[]): boolean { return a.length === b.length && a.every((byte, i) => byte === b[i]); }
export function copyBlocks(blocks: SettingsBlocks): SettingsBlocks { return { base: [...blocks.base], left: [...blocks.left], right: [...blocks.right] }; }
