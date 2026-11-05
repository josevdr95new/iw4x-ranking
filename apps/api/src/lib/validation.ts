/** NetworkId de IW4MAdmin: entero de 64 bits representado como string decimal. */
export const GUID_PATTERN = /^[0-9]{1,20}$/;

/** Parsea un entero acotado con valor por defecto (para query params libres). */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  let parsed: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    parsed = Math.trunc(value);
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = Number.parseInt(value, 10);
  } else {
    return fallback;
  }
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
