import type { TimeField } from './types';

/**
 * Apply a land mask ('1' = on-network) to a time field: masked cells become
 * Infinity so the heat stops at water instead of gliding across it.
 * Returns a new array; the input (used for venue scoring) is untouched.
 */
export function maskField(field: TimeField, mask: string): Float32Array {
  const out = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) {
    out[i] = mask.charCodeAt(i) === 49 ? field[i] : Infinity;
  }
  return out;
}
