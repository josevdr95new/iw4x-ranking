import { ApiError } from "./api";

/** El server no respondió por rcon (502 MODERATION_UNREACHABLE): mismo texto que la moderación. */
export const SERVER_DOWN_TEXT =
  "El server no respondió por RCON — puede estar caído o reiniciando. Vuelve a intentarlo en unos segundos.";
export const RCON_NOT_CONFIGURED_TEXT =
  "El control por RCON no está configurado en la API del ranking (falta RCON_PASSWORD).";

/** Mensaje humano para errores rcon (502/503) o genéricos. */
export function rconErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 502) return SERVER_DOWN_TEXT;
    if (error.status === 503) return RCON_NOT_CONFIGURED_TEXT;
    return error.message;
  }
  return "No hay conexión con el servidor.";
}
