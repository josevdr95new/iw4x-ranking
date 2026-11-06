import { z } from 'zod';

/** Un server conocido para launcher/web: {name, address, isDefault?}. */
export const serverEntrySchema = z.object({
  name: z.string().trim().min(1).max(64),
  address: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.:-]{3,64}$/, 'La dirección debe ser host:puerto (ej. 192.168.2.251:28960)'),
  isDefault: z.boolean().optional().default(false),
});

export const serversListSchema = z.array(serverEntrySchema).min(1).max(20);

export type ServerEntry = z.infer<typeof serverEntrySchema>;

// ── PUT /api/admin/server-config ───────────────────────────────────────────

const GAMETYPES = ['war', 'dm', 'dom', 'koth', 'sab', 'sd', 'ctf', 'oneflag', 'gtnw', 'arena', 'dd', 'vip'] as const;

/** Texto para ir entre comillas en el cfg: sin comillas/saltos (los ^colores sí se permiten). */
const quotedText = (max: number) =>
  z
    .string()
    .max(max, `Máximo ${max} caracteres`)
    .refine((value) => !/["\r\n]/.test(value), 'No puede contener comillas ni saltos de línea');

export const serverConfigUpdateSchema = z
  .object({
    hostname: quotedText(64).optional(),
    motd: quotedText(128).optional(),
    gametype: z.enum(GAMETYPES).optional(),
    maxclients: z.number().int().min(1, 'maxclients mínimo 1').max(64, 'maxclients máximo 64').optional(),
    logfile: z.number().int().min(0).max(2).optional(),
    g_log: z
      .string()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9_./\\-]{0,63}$/, 'g_log debe ser un nombre de archivo válido (ej. logs/games_mp.log)')
      .optional(),
    /** null = vaciar; string con '•' = eco enmascarado (sin cambio); otro string = nuevo valor. */
    rcon: z.string().max(64).nullable().optional(),
    bots: z.number().int().min(0).max(24).optional(),
    password: z.string().max(32).nullable().optional(),
    rotation: z
      .array(
        z.object({
          map: z.string().regex(/^[a-z0-9_]{2,32}$/, 'Mapa inválido (ej. mp_rust)'),
          gametype: z.enum(GAMETYPES).nullish(),
        }),
      )
      .min(1, 'La rotación necesita al menos 1 mapa')
      .max(32)
      .optional(),
  })
  .strict();

export type ServerConfigUpdate = z.infer<typeof serverConfigUpdateSchema>;
