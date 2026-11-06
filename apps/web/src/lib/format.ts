const intFormatter = new Intl.NumberFormat("es-ES");

const decimalFormatter = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dayMonthFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "short",
});

const monthYearFormatter = new Intl.DateTimeFormat("es-ES", {
  month: "short",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("es-ES", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Miles con punto: 12.430 */
export function formatInt(value: number): string {
  return intFormatter.format(value);
}

/** Decimal con coma española: 2,39 */
export function formatDecimal(value: number): string {
  return decimalFormatter.format(value);
}

/** Skill opcional: si no existe, "—" (nunca 0). DESIGN.md §11 supuesto E. */
export function formatSkill(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : formatDecimal(value);
}

/** Tiempo jugado en segundos: ≥1 h → "142 h", <1 h → "37 min". DESIGN.md §9. */
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  if (hours >= 1) return `${intFormatter.format(hours)} h`;
  const minutes = Math.max(1, Math.floor(totalSeconds / 60));
  return `${intFormatter.format(minutes)} min`;
}

/** Umbral de "en línea": conexión en los últimos 5 minutos. */
export const ONLINE_WINDOW_MINUTES = 5;

export function isOnline(lastConnection: string): boolean {
  const diffMinutes = (Date.now() - new Date(lastConnection).getTime()) / 60000;
  return diffMinutes >= 0 && diffMinutes <= ONLINE_WINDOW_MINUTES;
}

/** "hace 2 min / hace 5 h / hace 3 días / el 12 mar". DESIGN.md §9. */
export function formatRelative(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "—";
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 0) return "ahora mismo";
  if (minutes < 60) return `hace ${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? "hace 1 día" : `hace ${days} días`;
  return `el ${dayMonthFormatter.format(date)}`;
}

/** "05 nov 20:14" para el historial del perfil. */
export function formatTimestamp(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "—";
  return `${dayMonthFormatter.format(date)} ${timeFormatter.format(date)}`;
}

/** "mar 2026" para "Miembro desde…". */
export function formatMemberSince(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "—";
  return monthYearFormatter.format(date);
}

export type KdTone = "success" | "neutral" | "warning" | "danger";

/** Umbral oficial de K/D. DESIGN.md §1.1. */
export function kdTone(kd: number): KdTone {
  if (kd >= 1.2) return "success";
  if (kd >= 1) return "neutral";
  if (kd >= 0.8) return "warning";
  return "danger";
}

/** Clase de texto por tono de K/D (para celdas y fila-card móvil). */
export function kdTextClass(kd: number): string {
  const tone = kdTone(kd);
  switch (tone) {
    case "success":
      return "text-accent";
    case "neutral":
      return "text-text";
    case "warning":
      return "text-warning";
    case "danger":
      return "text-danger";
  }
}

/** Iniciales para avatar (2 caracteres). */
export function initialsOf(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ]/g, "");
  return cleaned.slice(0, 2).toUpperCase() || "??";
}

/** GUID numérico agrupado en bloques de 4 para lectura; el dato crudo queda en title. */
export function formatGuid(guid: string): string {
  return guid.replace(/(\d{4})(?=\d)/g, "$1 ");
}
