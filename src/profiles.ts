import { DEFAULT, DISABLED, SOURCE_KEYS, TARGET_KEYS } from './protocol.ts';
import type { SourceKey } from './protocol.ts';
export interface Profile { version: 1; name: string; mappings: Partial<Record<SourceKey, number>> }
export function validateProfile(value: unknown): Profile {
  if (!value || typeof value !== 'object') throw new Error('Invalid profile file.');
  const p = value as Record<string, unknown>;
  if (p.version !== 1 || typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 64 || !p.mappings || typeof p.mappings !== 'object' || Array.isArray(p.mappings)) throw new Error('Expected a version 1 BeiTong profile with a name and button mappings.');
  const mappings: Profile['mappings'] = {};
  for (const [key, target] of Object.entries(p.mappings)) {
    if (!SOURCE_KEYS.includes(key as SourceKey) || typeof target !== 'number' || !Number.isInteger(target) || !(target === DEFAULT || target === DISABLED || target >= 0 && target < TARGET_KEYS.length)) throw new Error(`Invalid mapping for ${key}.`);
    mappings[key as SourceKey] = target;
  }
  return { version: 1, name: p.name, mappings };
}
export const PRESETS: Record<string, Profile['mappings']> = {
  default: Object.fromEntries(SOURCE_KEYS.map(key => [key, DEFAULT])),
  swap: { A: 1, B: 0, X: 3, Y: 2 },
  classic: { M1: 12, M2: 11 },
  soul: { M1: 12, M2: 1 },
};
