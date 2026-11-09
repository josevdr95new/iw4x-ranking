import { z } from 'zod';

/**
 * Ingesta de clases de loadout (customClasses) desde el dump del CLIENTE:
 * el jugador ejecuta `/dumpPlayerData` en su consola de juego → el árbol DDL
 * completo queda en su `console_mp.log` → el texto (puede ser el log ENTERO)
 * se envía aquí y el parser busca la sección `customClasses`.
 *
 * NO validamos enums (armas/camos/perks custom de mods son legítimos): el dump
 * es verdad del cliente y el parser guarda los valores tal cual.
 */

/** El console_mp.log entero puede traer mucho más que customClasses: cap generoso. */
export const MAX_DUMP_TEXT_CHARS = 900_000;

export const saveClassesSchema = z
  .object({
    dumpText: z
      .string()
      .min(1, 'dumpText no puede estar vacío.')
      .max(MAX_DUMP_TEXT_CHARS, `dumpText excede el máximo de ${MAX_DUMP_TEXT_CHARS} caracteres.`),
  })
  .strict();

export type SaveClassesInput = z.infer<typeof saveClassesSchema>;
