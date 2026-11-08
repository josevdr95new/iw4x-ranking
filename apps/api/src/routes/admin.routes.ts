import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getServerConfig, restartServer, updateServerConfig } from '../services/serverconfig.service.js';
import { asyncHandler } from '../lib/http.js';
import { validate, parseWith } from '../middleware/validate.js';
import {
  createPenalty,
  getModerationStatus,
  getLivePlayers,
  getPenaltyHistory,
  getServerBans,
  searchModerationClients,
  unbanPlayer,
  type PunisherInfo,
} from '../services/moderation.service.js';
import { getAliasConflicts } from '../services/alias.service.js';
import {
  iamClientsQuery,
  iamLiveQuery,
  iamPenaltiesQuery,
  iamPenaltyInput,
  iamUnbanInput,
} from '../dto/iam.dto.js';
import { identityAlertsQuery, identityAlertResolveInput, identityAlertIdParam } from '../dto/identity.dto.js';
import { getIdentityAlerts, resolveIdentityAlert } from '../services/identity.service.js';
import {
  botsCountInput,
  botsDifficultyInput,
  launcherOnlyInput,
  mapChangeInput,
} from '../dto/serveradmin.dto.js';
import { getActivePlaySessions } from '../services/play-session.service.js';
import { getLauncherOnly, setLauncherOnly } from '../services/setting.service.js';
import {
  changeMap,
  fastRestart,
  getMapsOverview,
  rotateMap,
} from '../services/server-maps.service.js';
import {
  getBotsOverview,
  setBotCount,
  setBotDifficulty,
} from '../services/server-bots.service.js';

export const adminRouter: Router = Router();

// Toda la rama /admin exige JWT + rol ADMIN (leído fresco de la DB en cada request).
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get(
  '/server-config',
  asyncHandler(async (_req, res) => {
    res.json({ config: await getServerConfig() });
  }),
);

adminRouter.put(
  '/server-config',
  asyncHandler(async (req, res) => {
    res.json(await updateServerConfig(req.body ?? {}));
  }),
);

adminRouter.post(
  '/server/restart',
  asyncHandler(async (_req, res) => {
    res.json(await restartServer());
  }),
);

// Anti-confusión de identidades (read-only): colisiones de nombre entre GUIDs
// y guids con múltiples alias históricos (PCs compartidas / renombres).
adminRouter.get(
  '/alias-conflicts',
  asyncHandler(async (_req, res) => {
    res.json(await getAliasConflicts());
  }),
);

// ── Alertas de identidad (impersonación de nick registrado) ─────────────────

adminRouter.get(
  '/identity-alerts',
  validate(identityAlertsQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await getIdentityAlerts(req.query as unknown as Parameters<typeof getIdentityAlerts>[0]));
  }),
);

adminRouter.post(
  '/identity-alerts/:id/resolve',
  asyncHandler(async (req, res) => {
    const { id } = parseWith(identityAlertIdParam, req.params);
    const { action } = parseWith(identityAlertResolveInput, req.body ?? {});
    res.json(await resolveIdentityAlert(id, action));
  }),
);

// ── Moderación NATIVA por RCON del server IW4x (/api/admin/iam/*) ──────────
// Mismos paths/shapes que consumía la web (ModerationPanel/PenaltyModal);
// implementación interna nueva: rcon directo + historial en NUESTRA DB.

// El admin del JWT queda registrado como punisher de cada penalidad.
function punisherOf(req: { user?: { id: number; displayName: string } }): PunisherInfo | undefined {
  if (!req.user) return undefined;
  return { userId: req.user.id, name: req.user.displayName };
}

adminRouter.get(
  '/iam/status',
  asyncHandler(async (_req, res) => {
    res.json(await getModerationStatus());
  }),
);

adminRouter.get(
  '/iam/clients',
  validate(iamClientsQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await searchModerationClients(req.query as unknown as Parameters<typeof searchModerationClients>[0]));
  }),
);

adminRouter.get(
  '/iam/penalties',
  validate(iamPenaltiesQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await getPenaltyHistory(req.query as unknown as Parameters<typeof getPenaltyHistory>[0]));
  }),
);

adminRouter.get(
  '/iam/live',
  validate(iamLiveQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await getLivePlayers(req.query as unknown as Parameters<typeof getLivePlayers>[0]));
  }),
);

adminRouter.post(
  '/iam/penalty',
  asyncHandler(async (req, res) => {
    const input = parseWith(iamPenaltyInput, req.body ?? {});
    res.json(await createPenalty(input, punisherOf(req)));
  }),
);

// Nuevos (nativos): unban vía rcon + bans.json read-only del server.
adminRouter.post(
  '/iam/unban',
  asyncHandler(async (req, res) => {
    const input = parseWith(iamUnbanInput, req.body ?? {});
    res.json(await unbanPlayer(input, punisherOf(req)));
  }),
);

adminRouter.get(
  '/iam/bans',
  asyncHandler(async (_req, res) => {
    res.json(await getServerBans());
  }),
);

// ── Sesiones de juego (launcher) + launcher-only ───────────────────────────

adminRouter.get(
  '/server/sessions',
  asyncHandler(async (_req, res) => {
    res.json({ sessions: await getActivePlaySessions() });
  }),
);

adminRouter.get(
  '/server/launcher-only',
  asyncHandler(async (_req, res) => {
    res.json({ enabled: await getLauncherOnly() });
  }),
);

adminRouter.post(
  '/server/launcher-only',
  validate(launcherOnlyInput, 'body'),
  asyncHandler(async (req, res) => {
    const { enabled } = parseWith(launcherOnlyInput, req.body ?? {});
    res.json({ enabled: await setLauncherOnly(enabled) });
  }),
);

// ── Mapas (catálogo MW2/IW4x + control por rcon) ───────────────────────────

adminRouter.get(
  '/server/maps',
  asyncHandler(async (_req, res) => {
    res.json(await getMapsOverview());
  }),
);

adminRouter.post(
  '/server/map',
  validate(mapChangeInput, 'body'),
  asyncHandler(async (req, res) => {
    const { map } = parseWith(mapChangeInput, req.body ?? {});
    res.json(await changeMap(map));
  }),
);

adminRouter.post(
  '/server/rotate',
  asyncHandler(async (_req, res) => {
    res.json(await rotateMap());
  }),
);

adminRouter.post(
  '/server/fast_restart',
  asyncHandler(async (_req, res) => {
    res.json(await fastRestart());
  }),
);

// ── Bots (dvars Bot Warfare + spawnBot/kick por rcon) ──────────────────────

adminRouter.get(
  '/server/bots',
  asyncHandler(async (_req, res) => {
    res.json(await getBotsOverview());
  }),
);

adminRouter.post(
  '/server/bots/difficulty',
  validate(botsDifficultyInput, 'body'),
  asyncHandler(async (req, res) => {
    const { level } = parseWith(botsDifficultyInput, req.body ?? {});
    res.json(await setBotDifficulty({ level }));
  }),
);

adminRouter.post(
  '/server/bots/count',
  validate(botsCountInput, 'body'),
  asyncHandler(async (req, res) => {
    const { count } = parseWith(botsCountInput, req.body ?? {});
    res.json(await setBotCount(count));
  }),
);
