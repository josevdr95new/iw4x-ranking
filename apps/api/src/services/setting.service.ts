import { prisma } from '../lib/prisma.js';

/**
 * Configuración key-value PERSISTENTE del panel (tabla Setting).
 * Los valores se guardan como JSON (string) para que el shape evolucione sin
 * migraciones. Sobrevive restarts del proceso (a diferencia de memoria).
 *
 * Claves conocidas:
 *  - "launcher_only": { enabled: boolean } — el enforcer expulsa a los humanos
 *    sin sesión de juego activa (anti no-launcher). Default FALSE.
 *  - "anti_unlock_autokick": { enabled: boolean } — el ingesta live (livestats)
 *    KICKEA a quien detecte con XP imposible (unlockstats). Default FALSE
 *    (solo alerta: flag en /api/admin/server/livestats + log).
 */

/** Claves de setting usadas por el backend (constantes para evitar typos). */
export const SETTING_KEYS = {
  launcherOnly: 'launcher_only',
  antiUnlockAutokick: 'anti_unlock_autokick',
} as const;

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  try {
    const parsed: unknown = JSON.parse(row.value);
    return parsed as T;
  } catch {
    return fallback; // fila corrupta: fallback (el write siempre escribe JSON válido)
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  });
}

/** launcher-only (default false): expone el booleano crudo para panel + enforcer. */
export async function getLauncherOnly(): Promise<boolean> {
  const stored = await getSetting<{ enabled: boolean }>(SETTING_KEYS.launcherOnly, { enabled: false });
  return stored.enabled === true;
}

export async function setLauncherOnly(enabled: boolean): Promise<boolean> {
  await setSetting(SETTING_KEYS.launcherOnly, { enabled });
  return enabled;
}

/** anti-unlock autokick (default false): true = kick además del flag/alerta. */
export async function getAntiUnlockAutokick(): Promise<boolean> {
  const stored = await getSetting<{ enabled: boolean }>(SETTING_KEYS.antiUnlockAutokick, { enabled: false });
  return stored.enabled === true;
}

export async function setAntiUnlockAutokick(enabled: boolean): Promise<boolean> {
  await setSetting(SETTING_KEYS.antiUnlockAutokick, { enabled });
  return enabled;
}
