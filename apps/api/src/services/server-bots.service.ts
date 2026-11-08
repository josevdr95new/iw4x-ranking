/**
 * CONTROL DE BOTS del server dedicado IW4x por RCON (panel admin).
 *
 * DVARS REALES (verificadas contra el source):
 *  - Módulo C++ IW4x (src/Components/Modules/Bots.cpp @ r5318) registra SOLO:
 *      · sv_randomBotNames (bool, default false): "Randomize the bots' names".
 *      · sv_replaceBots   (bool, default false): "Test clients will be replaced
 *        by connecting players when the server is full."
 *    y el comando AddSV `spawnBot [n|all]` (spawnea test clients, 500ms entre
 *    cada uno; "Server is full" si no hay slot).
 *  - La DIFICULTAD vive en los scripts GSC de Bot Warfare (maps/mp/bots/_bot.gsc
 *    de ineedbots/iw4_bot_warfare), NO en C++:
 *      · bots_skill (int, default 0): 0=aleatorio dentro de min/max, 1..7=fijo
 *        (1 fácil → 7 difícil), 8=custom per-team, 9=aleatorio continuo.
 *      · bots_skill_min/max (default 1/7): clamp del skill base.
 *      · bots_skill_allies_hard / bots_skill_allies_med / bots_skill_axis_hard /
 *        bots_skill_axis_med (default 0): CON bots_skill=8, número de bots
 *        hard (skill 7) y med (skill 4) por team; el resto queda en skill 1.
 *      · bots_manage_add / bots_manage_fill / bots_manage_fill_mode /
 *        bots_manage_fill_kick: gestión automática de lobby (si el mod está).
 *
 * SEMÁNTICA DEL CAMBIO DE DIFICULTAD (verificada en _bot.gsc, loop `diffBots`
 * cada 1.5s): con bots_skill en 1..7 el skill se RE-APLICA a los bots YA
 * conectados en ≤1.5s (NO solo a bots nuevos). Solo bots_skill=0/9 eligen
 * skill aleatorio por bot AL APARECER (dentro del clamp min/max). OJO: si el
 * mod GSC NO está instalado (server con bots "vanilla" de Bots.cpp), la dvar
 * no existe (lectura: `Unknown command`) y `set bots_skill N` es INERTE hasta
 * instalar el mod — se refleja en la API con value:null + note.
 *
 * Formato de LECTURA de dvar por rcon (verificado EN VIVO contra el server
 * 127.0.0.1:28961): `"name" is: "valor^7" default: "def^7"` (el valor trae el
 * código de color ^7 que se limpia; dvar inexistente → `Unknown command "x"`,
 * se reporta value:null). La ESCRITURA usa `set <dvar> <valor>` (1 intento).
 */
import { getSharedRcon, isRconConfigured, stripColorCodes } from '../lib/rcon/iw4x-rcon.js';
import { toAppError } from './moderation.service.js';
import { AppError } from '../lib/errors.js';

/** Dvars leídas por GET /server/bots (módulo C++ + Bot Warfare si está). */
export const BOT_DVARS = [
  'sv_randomBotNames',
  'sv_replaceBots',
  'bots_skill',
  'bots_skill_min',
  'bots_skill_max',
  'bots_skill_allies_hard',
  'bots_skill_allies_med',
  'bots_skill_axis_hard',
  'bots_skill_axis_med',
  'bots_manage_fill',
  'bots_manage_fill_mode',
  'bots_manage_fill_kick',
  'bots_manage_add',
] as const;

export const SKILL_DVAR = 'bots_skill';

// ── Lectura de dvars ────────────────────────────────────────────────────────

export interface DvarValue {
  name: string;
  /** Valor actual limpio (sin ^X); null si la dvar no existe en el server. */
  value: string | null;
  /** Default declarado; null si la dvar no existe. */
  default: string | null;
}

const DVAR_LINE = /^\s*"([^"]+)"\s+is:\s+"([^"]*)"(?:\s+default:\s+"([^"]*)")?/;

/** Parsea la respuesta rcon de una dvar (una línea `"x" is: "v" default: "d"`). */
export function parseDvarReply(payload: string): DvarValue | null {
  const line = payload.split(/\r?\n/).find((candidate) => DVAR_LINE.test(candidate));
  if (!line) return null;
  const m = DVAR_LINE.exec(line);
  if (!m) return null;
  return {
    name: m[1] ?? '',
    value: m[2] !== undefined ? stripColorCodes(m[2]) : null,
    default: m[3] !== undefined ? stripColorCodes(m[3]) : null,
  };
}

/** Lee UNA dvar por rcon (lectura con reintentos del cliente). */
async function readDvar(name: string): Promise<DvarValue> {
  const payload = await getSharedRcon().exec(name);
  const parsed = parseDvarReply(payload);
  if (!parsed) return { name, value: null, default: null };
  return { name, value: parsed.value, default: parsed.default };
}

function assertRconConfigured(): void {
  if (!isRconConfigured()) {
    throw new AppError(
      503,
      'MODERATION_NOT_CONFIGURED',
      'La moderación nativa no está configurada: define RCON_PASSWORD.',
    );
  }
}

// ── GET /api/admin/server/bots ──────────────────────────────────────────────

export interface BotsOverview {
  /** Nº de bots conectados AHORA (filas botN del status). */
  count: number;
  difficulty: {
    dvar: typeof SKILL_DVAR;
    /** Valor actual (null = dvar inexistente: mod Bot Warfare NO instalado). */
    value: string | null;
    /** Default declarado (null si no existe). */
    default: string | null;
    /** false → el server no tiene el mod GSC: `set bots_skill` sería inerte. */
    found: boolean;
    note: string;
  };
  /** Valores leídos de TODAS las dvars de interés (null = no existe). */
  dvars: Record<string, string | null>;
}

export async function getBotsOverview(): Promise<BotsOverview> {
  assertRconConfigured();
  try {
    const status = await getSharedRcon().status();
    const count = status.players.filter((player) => player.isBot && !player.connecting).length;

    const values: DvarValue[] = [];
    for (const name of BOT_DVARS) {
      values.push(await readDvar(name));
    }
    const skill = values.find((v) => v.name === SKILL_DVAR) ?? { name: SKILL_DVAR, value: null, default: null };
    const dvars: Record<string, string | null> = {};
    for (const entry of values) dvars[entry.name] = entry.value;

    return {
      count,
      difficulty: {
        dvar: SKILL_DVAR,
        value: skill.value,
        default: skill.default,
        found: skill.value !== null,
        note:
          skill.value === null
            ? 'bots_skill no existe en el server: el mod GSC Bot Warfare no está instalado (los bots usan la IA vanilla de Bots.cpp). Instala iw4_bot_warfare para que la dificultad tenga efecto.'
            : 'bots_skill: 0=aleatorio (min/max), 1-7=fijo (1 fácil → 7 difícil), 8=custom por equipo, 9=aleatorio continuo.',
      },
      dvars,
    };
  } catch (err) {
    throw toAppError(err);
  }
}

// ── POST /api/admin/server/bots/difficulty ──────────────────────────────────

/** Tipo del input validado por zod (level: number 0-9 | per-team con contadores). */
export type BotDifficultyInput = import('../dto/serveradmin.dto.js').BotsDifficultyInput;

export interface BotDifficultyResult {
  sent: true;
  dvar: string;
  value: string;
  commands: string[];
  note: string;
}

function dvarWrite(command: string): Promise<string> {
  return getSharedRcon().exec(command, { write: true });
}

/**
 * Cambia la dificultad de los bots:
 *  - level entero 0-9 → `set bots_skill <n>`.
 *  - level objeto per-team → `set bots_skill 8` + `set bots_skill_<team>_<n> <k>`
 *    por cada contador presente (hard=skill 7, med=skill 4, resto=1).
 */
export async function setBotDifficulty(input: BotDifficultyInput): Promise<BotDifficultyResult> {
  assertRconConfigured();
  try {
    const commands: string[] = [];
    if (typeof input.level === 'number') {
      const value = String(input.level);
      commands.push(`set ${SKILL_DVAR} ${value}`);
    } else {
      const perTeam = input.level;
      const parts: Array<[string, number]> = [];
      if (perTeam.alliesHard !== undefined) parts.push(['bots_skill_allies_hard', perTeam.alliesHard]);
      if (perTeam.alliesMed !== undefined) parts.push(['bots_skill_allies_med', perTeam.alliesMed]);
      if (perTeam.axisHard !== undefined) parts.push(['bots_skill_axis_hard', perTeam.axisHard]);
      if (perTeam.axisMed !== undefined) parts.push(['bots_skill_axis_med', perTeam.axisMed]);
      if (parts.length === 0) {
        commands.push(`set ${SKILL_DVAR} 8`); // modo custom sin contadores: todos quedan en skill 1
      } else {
        commands.push(`set ${SKILL_DVAR} 8`);
        for (const [dvar, amount] of parts) commands.push(`set ${dvar} ${amount}`);
      }
    }

    for (const command of commands) {
      await dvarWrite(command);
    }

    const value = commands.map((c) => c.replace(/^set /, '')).join(' ');
    return {
      sent: true,
      dvar: SKILL_DVAR,
      value,
      commands,
      note:
        'Enviado. Semántica verificada en el source (_bot.gsc, loop diffBots cada 1.5s): con bots_skill 1-7 el skill se re-aplica a los bots YA conectados en ≤1.5s; con 0/9 cada bot nuevo elige skill aleatorio al aparecer (clamp bots_skill_min/max); 8 usa los contadores por equipo. Si el mod Bot Warfare no está instalado la dvar es inerte (ver GET /server/bots → difficulty.found).',
    };
  } catch (err) {
    throw toAppError(err);
  }
}

// ── POST /api/admin/server/bots/count ───────────────────────────────────────

export interface BotCountResult {
  sent: true;
  requested: number;
  before: number;
  after: number;
  spawned: number;
  kicked: Array<{ cid: number; guid: string; name: string }>;
  note: string;
}

/**
 * Ajusta el nº de bots al valor pedido:
 *  - faltan → UN comando `spawnBot <k>` (el engine spawnea 1 cada ~500ms).
 *  - sobran → `clientkick <cid>` de los bots sobrantes (SOLO bots: nunca
 *    humanos; se toma la lista de bots del status en vivo).
 *  - igual → no envía nada (sent igualmente true, sin acciones).
 * Verificación: re-lee status al final (`after`). Los bots nuevos pueden
 * seguir negociando (CNCT) cuando se re-lee: se anota en `note`.
 */
export async function setBotCount(requested: number, verifyWaitMs = 2_000): Promise<BotCountResult> {
  assertRconConfigured();
  try {
    const rcon = getSharedRcon();
    const status = await rcon.status();
    const bots = status.players.filter((player) => player.isBot && !player.connecting);
    const before = bots.length;
    const kicked: Array<{ cid: number; guid: string; name: string }> = [];
    let spawned = 0;

    if (requested > before) {
      const missing = requested - before;
      await rcon.spawnBot(missing);
      spawned = missing;
    } else if (requested < before) {
      const surplus = before - requested;
      for (const bot of bots.slice(-surplus)) {
        try {
          await rcon.clientkick(bot.cid);
          kicked.push({ cid: bot.cid, guid: bot.guid.toLowerCase(), name: stripColorCodes(bot.name) });
        } catch {
          // kick de bot fallido: se reporta en `after` (el status manda).
        }
      }
    }

    // Verificación con status: tras spawn esperamos a que el engine cree los
    // bots (~500ms/bot, cap 8s); tras kicks, una pausa breve; no-op → inmediato.
    if (spawned > 0) {
      const spawnWait = Math.min(1_000 + spawned * 600, 8_000);
      await new Promise((resolve) => setTimeout(resolve, Math.max(spawnWait, verifyWaitMs)));
    } else if (kicked.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, verifyWaitMs));
    }
    const fresh = await rcon.status();
    const after = fresh.players.filter((player) => player.isBot && !player.connecting).length;

    return {
      sent: true,
      requested,
      before,
      after,
      spawned,
      kicked,
      note:
        'spawnBot añade ~1 bot cada 500ms (engine); si el server está lleno ignora el excedente. Los kicks son SIEMPRE de bots (por cid, tomados del status en vivo). Re-verificado con status: `after` puede quedar por debajo de `requested` mientras los bots nuevos terminan de conectar (CNCT).',
    };
  } catch (err) {
    throw toAppError(err);
  }
}
