import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Gavel,
  Inbox,
  RefreshCcw,
  Search,
  SearchX,
  ShieldAlert,
  ShieldOff,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../../lib/api";
import type {
  IamBansResponse,
  IamLiveResponse,
  IamPenalty,
  IamPenaltyRecordType,
  IamPenaltyResponse,
  IamPenaltyType,
  IamStatusResponse,
} from "../../lib/api";
import { PenaltyModal, PENALTY_TYPE_LABEL, stripColorCodes } from "../../components/PenaltyModal";
import type { PenaltyTarget } from "../../components/PenaltyModal";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { Panel } from "../../components/ui/Panel";
import { Skeleton, Spinner } from "../../components/ui/Spinner";
import { formatInt, formatRelative } from "../../lib/format";

const LIVE_POLL_MS = 15000;
const CLIENT_SEARCH_DEBOUNCE_MS = 400;
const KICK_DEFAULT_REASON = "Expulsado por un administrador";

/** El server no respondió por rcon (502 MODERATION_UNREACHABLE): mensaje claro de server caído. */
const SERVER_DOWN_TEXT =
  "El server no respondió por RCON — puede estar caído o reiniciando. Vuelve a intentarlo en unos segundos.";

/** Badge de color por tipo de penalidad: warn avisa, kick neutral, bans peligro, unban éxito. */
function PenaltyTypeBadge({ type }: { type: IamPenaltyRecordType }) {
  const variant =
    type === "warn"
      ? "warning"
      : type === "kick"
        ? "neutral"
        : type === "unban"
          ? "success"
          : "danger";
  return <Badge variant={variant}>{PENALTY_TYPE_LABEL[type]}</Badge>;
}

/** Badge de bot: idéntico al del leaderboard (hairline + mono, no altera las filas humanas). */
function BotTag() {
  return (
    <span
      title="Bot del server"
      className="type-mono inline-flex h-[18px] items-center rounded-none border border-border px-1.5 text-[10px] leading-none text-text-2"
    >
      BOT
    </span>
  );
}

/** Slot del server (cid): mono, la clave para actuar contra bots. */
function SlotTag({ slot }: { slot: number | null }) {
  return (
    <span title="Slot del server (cid)" className="type-mono text-text-2">
      {slot === null ? "—" : `#${slot}`}
    </span>
  );
}

/* --- Panel principal --- */

type StatusState =
  | { phase: "loading" }
  | { phase: "unreachable"; error: string | null }
  | { phase: "ready"; status: IamStatusResponse; checkedAt: number };

interface KickConfirmState {
  key: string;
  name: string;
  clientId: number | null;
  cid: number | null;
}

export function ModerationPanel() {
  const [statusState, setStatusState] = useState<StatusState>({ phase: "loading" });
  const [statusReloadKey, setStatusReloadKey] = useState(0);

  const [live, setLive] = useState<IamLiveResponse | null>(null);
  const [liveState, setLiveState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [liveError, setLiveError] = useState<string | null>(null);

  const [clientQueryInput, setClientQueryInput] = useState("");
  const [clientResults, setClientResults] = useState<Awaited<ReturnType<typeof api.iamClients>> | null>(null);
  const [clientState, setClientState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [clientsError, setClientsError] = useState<string | null>(null);

  const [penalties, setPenalties] = useState<IamPenalty[]>([]);
  const [penaltiesState, setPenaltiesState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [penaltiesError, setPenaltiesError] = useState<string | null>(null);
  const [penaltiesLimit, setPenaltiesLimit] = useState(30);
  const [penaltiesReloadKey, setPenaltiesReloadKey] = useState(0);

  const [bansData, setBansData] = useState<IamBansResponse | null>(null);
  const [bansState, setBansState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [bansError, setBansError] = useState<string | null>(null);
  const [bansOpen, setBansOpen] = useState(false);
  const [bansReloadKey, setBansReloadKey] = useState(0);

  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [penaltyModal, setPenaltyModal] = useState<
    { target: PenaltyTarget; type: IamPenaltyType; allowTypeChoice?: boolean } | null
  >(null);

  const [kickConfirm, setKickConfirm] = useState<KickConfirmState | null>(null);
  const [kickReason, setKickReason] = useState(KICK_DEFAULT_REASON);
  const [kickBusy, setKickBusy] = useState(false);
  const [kickError, setKickError] = useState<{ key: string; code: string; text: string } | null>(null);

  const [unbanBusyId, setUnbanBusyId] = useState<number | null>(null);
  const [unbanError, setUnbanError] = useState<{ id: number; text: string } | null>(null);

  const ready = statusState.phase === "ready";
  const penaltiesDbConfigured = ready && statusState.status.penaltiesDb.configured;

  /* Estado del bridge: reintentable, siempre 200 con `error` legible (API.md). */
  useEffect(() => {
    let cancelled = false;
    setStatusState({ phase: "loading" });
    setNotice(null);
    api
      .iamStatus()
      .then((response) => {
        if (cancelled) return;
        if (!response.configured || !response.reachable || response.error) {
          setStatusState({ phase: "unreachable", error: response.error });
        } else {
          setStatusState({ phase: "ready", status: response, checkedAt: Date.now() });
        }
      })
      .catch(() => {
        if (!cancelled) setStatusState({ phase: "unreachable", error: null });
      });
    return () => {
      cancelled = true;
    };
  }, [statusReloadKey]);

  /* Jugadores en vivo: refresco cada 15 s, pausado con la pestaña oculta. */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      setLiveState((state) => (state === "ready" ? "ready" : "loading"));
      api
        .iamLive()
        .then((response) => {
          if (cancelled) return;
          setLive(response);
          setLiveState("ready");
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setLiveState("error");
          setLiveError(error instanceof ApiError && error.status === 502 ? SERVER_DOWN_TEXT : null);
        });
    };
    load();
    const interval = window.setInterval(load, LIVE_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready]);

  const refreshLive = useCallback(() => {
    setLiveState("loading");
    api
      .iamLive()
      .then((response) => {
        setLive(response);
        setLiveState("ready");
        setLiveError(null);
      })
      .catch((error: unknown) => {
        setLiveState("error");
        setLiveError(error instanceof ApiError && error.status === 502 ? SERVER_DOWN_TEXT : null);
      });
  }, []);

  /* Búsqueda de clientes: debounce, mínimo 3 chars. */
  useEffect(() => {
    const normalized = clientQueryInput.trim();
    if (normalized.length < 3) {
      setClientResults(null);
      setClientState("idle");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setClientState("loading");
      setClientsError(null);
      api
        .iamClients(normalized)
        .then((response) => {
          if (cancelled) return;
          setClientResults(response);
          setClientState("ready");
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setClientState("error");
          setClientsError(
            error instanceof ApiError ? error.message : "No se pudo buscar en la base de clientes.",
          );
        });
    }, CLIENT_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [clientQueryInput]);

  /* Historial de penalidades: solo si la DB proxy está configurada. Vacío real = válido. */
  useEffect(() => {
    if (!ready || !penaltiesDbConfigured) return;
    let cancelled = false;
    setPenaltiesState((state) => (state === "ready" ? "ready" : "loading"));
    setPenaltiesError(null);
    api
      .iamPenalties(penaltiesLimit)
      .then((response) => {
        if (cancelled) return;
        setPenalties(response.penalties);
        setPenaltiesState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPenaltiesState("error");
        setPenaltiesError(
          error instanceof ApiError ? error.message : "No se pudo cargar el historial de penalidades.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [ready, penaltiesDbConfigured, penaltiesLimit, penaltiesReloadKey]);

  /* Bans del server (bans.json, solo lectura): se carga en segundo plano para el contador del panel. */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setBansState((state) => (state === "ready" ? "ready" : "loading"));
    setBansError(null);
    api
      .iamBans()
      .then((response) => {
        if (cancelled) return;
        setBansData(response);
        setBansState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBansState("error");
        setBansError(error instanceof ApiError ? error.message : "No se pudieron leer los bans del server.");
      });
    return () => {
      cancelled = true;
    };
  }, [ready, bansReloadKey]);

  const refreshAfterPenalty = useCallback(() => {
    refreshLive();
    setPenaltiesReloadKey((key) => key + 1);
    // Un ban/tempban escribe bans.json del server: refresca también esa lista.
    setBansReloadKey((key) => key + 1);
  }, [refreshLive]);

  const handlePenaltyDone = useCallback(
    (response: IamPenaltyResponse) => {
      setPenaltyModal(null);
      setNotice({
        ok: true,
        text: `${PENALTY_TYPE_LABEL[response.type as IamPenaltyType] ?? response.type} @${response.clientId}: ${
          response.output.join(" · ") || "ejecutado"
        }`,
      });
      refreshAfterPenalty();
    },
    [refreshAfterPenalty],
  );

  /* KICK inline: confirmación en la propia fila (sin confirm() nativo), motivo editable. */
  const beginKick = useCallback((state: KickConfirmState) => {
    setKickConfirm(state);
    setKickReason(KICK_DEFAULT_REASON);
    setKickError(null);
  }, []);

  const executeKick = useCallback(async () => {
    if (!kickConfirm) return;
    const reason = kickReason.trim();
    if (reason.length < 3) return;
    setKickBusy(true);
    setKickError(null);
    try {
      const target =
        kickConfirm.clientId !== null && kickConfirm.clientId !== undefined
          ? { clientId: kickConfirm.clientId }
          : { cid: kickConfirm.cid as number };
      const response = await api.iamPenalty({ type: "kick", reason, ...target });
      setKickConfirm(null);
      setNotice({
        ok: true,
        text: `KICK ${stripColorCodes(kickConfirm.name)}: ${response.output.join(" · ") || "ejecutado"}`,
      });
      refreshAfterPenalty();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "UNKNOWN";
      const text =
        code === "CID_MISMATCH"
          ? "El slot cambió de jugador — reintenta."
          : error instanceof ApiError
            ? error.message
            : "No se pudo expulsar. Inténtalo de nuevo.";
      setKickError({ key: kickConfirm.key, code, text });
    } finally {
      setKickBusy(false);
    }
  }, [kickConfirm, kickReason, refreshAfterPenalty]);

  /* Levantar ban desde el historial: POST /unban con el guid del ofensor. */
  const handleUnban = useCallback(
    async (penalty: IamPenalty) => {
      const guid = penalty.offender?.guid;
      if (!guid) return;
      setUnbanBusyId(penalty.id);
      setUnbanError(null);
      try {
        const response = await api.iamUnban({ guid });
        setNotice({
          ok: true,
          text: `Ban levantado para ${stripColorCodes(penalty.offender?.name ?? null)}: ${
            response.output.join(" · ") || "ejecutado"
          }`,
        });
        setPenaltiesReloadKey((key) => key + 1);
        setBansReloadKey((key) => key + 1);
      } catch (error) {
        setUnbanError({
          id: penalty.id,
          text:
            error instanceof ApiError
              ? error.code === "CID_MISMATCH"
                ? "El slot cambió de jugador — reintenta."
                : error.message
              : "No se pudo levantar el ban. Inténtalo de nuevo.",
        });
      } finally {
        setUnbanBusyId(null);
      }
    },
    [],
  );

  const liveTotals = useMemo(() => {
    if (!live) return null;
    const online = live.servers.filter((server) => server.online).length;
    const players = live.servers.reduce((count, server) => count + server.players.length, 0);
    return { servers: live.servers.length, online, players };
  }, [live]);

  const canUnban = (penalty: IamPenalty): boolean =>
    (penalty.type === "ban" || penalty.type === "tempban") &&
    penalty.active === true &&
    typeof penalty.offender?.guid === "string" &&
    penalty.offender.guid.length > 0;

  if (statusState.phase === "loading") {
    return (
      <div aria-hidden="true" className="space-y-4">
        <div className="rounded-md border border-border bg-surface p-5">
          <Skeleton className="h-3 w-64" />
          <div className="mt-4 flex items-center gap-3">
            <Skeleton className="h-3" style={{ width: "45%" }} />
            <Skeleton className="h-3" style={{ width: "20%" }} />
            <Skeleton className="h-3" style={{ width: "25%" }} />
          </div>
        </div>
        <div className="rounded-md border border-border bg-surface p-5">
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
    );
  }

  if (statusState.phase === "unreachable") {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-4"
      >
        <WifiOff
          size={20}
          strokeWidth={1.75}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-warning"
        />
        <div className="min-w-0 flex-1">
          <h2 className="type-display-m text-warning">Server sin conexión — moderación deshabilitada</h2>
          <p className="type-body mt-1 max-w-[68ch] text-text-2">
            {statusState.error ??
              "No se pudo contactar el server por RCON. Revisa que esté corriendo y vuelve a intentarlo."}
          </p>
          <Button
            variant="ghost"
            className="mt-3"
            onClick={() => setStatusReloadKey((key) => key + 1)}
          >
            <RefreshCcw size={16} strokeWidth={1.75} aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      </div>
    );
  }

  const status = statusState.status;
  const livePlayers = live?.servers.flatMap((server) => server.players) ?? [];
  const kickReasonValid = kickReason.trim().length >= 3;
  const bansCount = bansData?.bans.length ?? 0;

  return (
    <div>
      {/* Estado del bridge */}
      <div
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-surface px-4 py-3"
      >
        <span className="type-label inline-flex items-center gap-2 text-accent">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
          Moderación por RCON conectada
        </span>
        <span className="type-caption text-text-2">
          {formatInt(status.servers.length)} {status.servers.length === 1 ? "server" : "servers"} ·
          historial de penalidades {status.penaltiesDb.configured ? "disponible" : "no configurado"}
        </span>
      </div>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={`mt-4 flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm ${
            notice.ok
              ? "border-accent-border bg-accent-subtle text-accent"
              : "border-danger/40 bg-danger/10 text-danger-hover"
          }`}
        >
          {notice.ok ? (
            <Check size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
          ) : (
            <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="min-w-0 break-words">{notice.text}</p>
            {!notice.ok && (
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setNotice(null)}>
                Volver
              </Button>
            )}
          </div>
          {notice.ok && (
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Descartar aviso"
              className="shrink-0 text-accent/70 transition-colors duration-150 ease-out hover:text-accent"
            >
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <div className="mt-4 space-y-4">
        {/* Jugadores en vivo */}
        <Panel
          title="Jugadores en vivo"
          caption={
            liveTotals
              ? `${formatInt(liveTotals.players)} conectados en ${formatInt(liveTotals.online)} de ${formatInt(liveTotals.servers)} servers`
              : "Consultando los servers…"
          }
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={refreshLive}
              disabled={liveState === "loading" || !ready}
              aria-label="Actualizar jugadores ahora"
            >
              {liveState === "loading" ? <Spinner size={14} /> : <RefreshCcw size={16} strokeWidth={1.75} aria-hidden="true" />}
              Actualizar
            </Button>
          }
        >
          {liveState === "error" ? (
            <EmptyState
              icon={WifiOff}
              title="No pudimos leer el estado en vivo."
              description={liveError ?? "Comprueba tu conexión e inténtalo de nuevo."}
              action={<Button size="sm" variant="ghost" onClick={refreshLive}>Reintentar</Button>}
            />
          ) : liveState === "idle" || liveState === "loading" ? (
            <div aria-hidden="true" className="space-y-3">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex items-center justify-between gap-4">
                  <Skeleton className="h-3" style={{ width: `${60 - index * 10}%` }} />
                  <Skeleton className="h-3 w-12" />
                </div>
              ))}
            </div>
          ) : livePlayers.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Nadie conectado ahora."
              description="Cuando alguien entre al server aparecerá aquí, con sus datos en vivo."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <caption className="sr-only">
                  Jugadores conectados ahora en los servers de la comunidad, con slot, ping y acciones.
                </caption>
                <thead>
                  <tr className="bg-surface">
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Jugador</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Slot</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right">
                      <span className="type-label text-text-2">Score</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right">
                      <span className="type-label text-text-2">Ping</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Estado</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right">
                      <span className="type-label text-text-2">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {live?.servers.map((server) =>
                    server.players.map((player, index) => {
                      const key = player.guid ?? `${server.id}-${index}-${stripColorCodes(player.name)}`;
                      const cleanName = stripColorCodes(player.name);
                      const kickTarget: KickConfirmState = {
                        key,
                        name: player.name,
                        clientId: player.clientId ?? null,
                        cid: player.clientNumber ?? null,
                      };
                      const hasSlot = player.clientNumber !== null && player.clientNumber !== undefined;
                      const kickRow = kickConfirm?.key === key;
                      return (
                        <tr
                          key={key}
                          className="border-b border-border transition-colors duration-150 ease-out last:border-b-0 hover:bg-surface-2"
                        >
                          <td className="max-w-[220px] px-3 py-2.5">
                            <span className="flex items-center gap-1.5">
                              <span
                                className="block truncate text-sm font-semibold text-text"
                                title={player.name}
                              >
                                {cleanName}
                              </span>
                              {player.isBot && <BotTag />}
                            </span>
                            {player.clientId === null && !player.isBot && (
                              <span className="type-caption block text-text-2">
                                sin cuenta en el ranking — se actúa por slot
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <SlotTag slot={player.clientNumber ?? null} />
                          </td>
                          <td data-numeric className="px-3 py-2.5 text-right">
                            <span className="type-number-m text-text">
                              {player.score === null ? "—" : formatInt(player.score)}
                            </span>
                          </td>
                          <td data-numeric className="px-3 py-2.5 text-right">
                            <span className="type-number-m text-text">
                              {player.ping === null ? "—" : formatInt(player.ping)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            {player.connecting ? (
                              <span className="type-caption text-warning">conectando…</span>
                            ) : (
                              <span className="type-caption text-text-2">{player.state}</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            {kickRow ? (
                              <div className="ml-auto flex w-[240px] flex-col items-stretch gap-1.5 text-left">
                                <p className="type-caption text-text">
                                  Kickear a{" "}
                                  <span className="font-semibold text-text">{cleanName}</span> del
                                  server
                                </p>
                                <input
                                  type="text"
                                  value={kickReason}
                                  maxLength={200}
                                  onChange={(event) => setKickReason(event.target.value)}
                                  placeholder="Motivo (mín. 3 caracteres)"
                                  aria-label={`Motivo del kick para ${cleanName}`}
                                  autoFocus
                                  className="h-8 rounded-sm border border-border bg-surface-2 px-2 text-sm text-text transition-colors duration-150 ease-out focus:border-accent focus:shadow-[0_0_0_1px_#8FD429] focus:outline-none"
                                />
                                {kickError?.key === key && (
                                  <p role="alert" className="type-caption text-danger-hover">
                                    {kickError.text}{" "}
                                    {kickError.code === "CID_MISMATCH" && (
                                      <button
                                        type="button"
                                        onClick={() => void executeKick()}
                                        disabled={kickBusy}
                                        className="font-semibold underline decoration-danger/40 transition-colors duration-150 ease-out hover:decoration-danger"
                                      >
                                        Reintentar
                                      </button>
                                    )}
                                  </p>
                                )}
                                <div className="mt-0.5 flex justify-end gap-1.5">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setKickConfirm(null)}
                                    disabled={kickBusy}
                                  >
                                    Volver
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    onClick={() => void executeKick()}
                                    disabled={!kickReasonValid || kickBusy}
                                    loading={kickBusy}
                                  >
                                    Kickear
                                  </Button>
                                </div>
                              </div>
                            ) : hasSlot ? (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => beginKick(kickTarget)}
                                  title={`Kick para ${cleanName}${player.isBot ? " (bot: solo kick)" : ""}`}
                                  className="type-button h-8 rounded-sm px-2 text-[12px] text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text"
                                >
                                  Kick
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPenaltyModal({
                                      target: {
                                        name: player.name,
                                        clientId: player.clientId,
                                        cid: player.clientNumber ?? null,
                                        isBot: player.isBot,
                                      },
                                      type: "warn",
                                      allowTypeChoice: true,
                                    })
                                  }
                                  title={`Castigar a ${cleanName}: warn, kick, tempban o ban`}
                                  className="type-button h-8 rounded-sm px-2 text-[12px] text-warning transition-colors duration-150 ease-out hover:bg-warning/10"
                                >
                                  Castigar…
                                </button>
                              </div>
                            ) : (
                              <span className="type-caption text-text-2" title="Sin slot ni clientId: no se puede actuar">
                                —
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
              {live?.servers.map((server) =>
                server.players.length === 0 ? null : (
                  <p key={server.id} className="type-caption mt-2 px-1 text-text-2">
                    Server: {stripColorCodes(server.name)}
                    {server.map || server.gametype ? " · " : ""}
                    {server.gametype && <span className="type-mono">{server.gametype}</span>}
                    {server.map && server.gametype ? " · " : ""}
                    {server.map && <span className="type-mono">{server.map}</span>}
                  </p>
                ),
              )}
            </div>
          )}
        </Panel>

        {/* Búsqueda de clientes */}
        <Panel
          title="Clientes"
          caption="Busca un cliente por nombre y revisa sus penalidades abiertas y nivel."
        >
          <div className="max-w-[420px]">
            <Input
              label=""
              aria-label="Buscar cliente por nombre"
              icon={<Search size={16} strokeWidth={1.75} aria-hidden="true" />}
              placeholder="Buscar cliente…"
              value={clientQueryInput}
              onChange={(event) => setClientQueryInput(event.target.value)}
              autoComplete="off"
            />
            {clientQueryInput.trim().length > 0 && clientQueryInput.trim().length < 3 && (
              <p className="type-caption mt-2 text-text-2">Mínimo 3 caracteres para buscar.</p>
            )}
          </div>

          {clientsError && (
            <p role="alert" className="mt-3 flex items-start gap-1.5 text-[13px] text-danger-hover">
              <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
              {clientsError}
            </p>
          )}

          {clientState === "loading" && (
            <div className="mt-4 flex items-center gap-2">
              <Spinner size={16} />
              <span className="type-caption text-text-2">Buscando clientes…</span>
            </div>
          )}

          {clientState === "ready" && clientResults !== null && (
            <div className="mt-4">
              <p className="type-caption text-text-2" aria-live="polite">
                {formatInt(clientResults.total)} {clientResults.total === 1 ? "coincidencia" : "coincidencias"}
              </p>
              {clientResults.clients.length === 0 ? (
                <div className="rounded-md border border-border">
                  <EmptyState
                    icon={SearchX}
                    title={`Ningún cliente coincide con «${clientResults.query}».`}
                    description="Prueba con otro nombre (el match ignora mayúsculas y códigos de color)."
                  />
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {clientResults.clients.map((client) => (
                    <li key={client.clientId} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-text" title={client.name}>
                          {stripColorCodes(client.name)}
                        </span>
                        {client.level && <Badge variant="neutral">{client.level}</Badge>}
                        {client.xuid && <span className="type-mono text-text-2">{client.xuid}</span>}
                        <span className="type-caption right-0 ml-auto text-text-2">#{client.clientId}</span>
                      </div>
                      <div className="mt-1.5">
                        {client.openPenalties === null ? (
                          <p className="type-caption text-text-2">
                            Penalidades abiertas no disponibles en el backend.
                          </p>
                        ) : client.openPenalties.length === 0 ? (
                          <p className="type-caption text-text-2">Sin penalidades abiertas.</p>
                        ) : (
                          <ul className="space-y-1">
                            {client.openPenalties.map((penalty) => (
                              <li key={penalty.id} className="flex flex-wrap items-center gap-2">
                                <PenaltyTypeBadge type={penalty.type} />
                                <span className="type-caption text-text-2">
                                  {penalty.reason ?? "Sin motivo registrado"} ·{" "}
                                  {penalty.expires ? `expira ${formatRelative(penalty.expires)}` : "sin vencimiento"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Panel>

        {/* Historial de penalidades */}
        <Panel
          title="Penalidades recientes"
          caption={
            penaltiesDbConfigured
              ? "Últimos warns, kicks y bans emitidos por la moderación."
              : "El historial no está disponible: falta configurar el historial de penalidades en el backend."
          }
          action={
            penaltiesDbConfigured ? (
              <div className="flex items-center gap-2">
                <label htmlFor="penalties-limit" className="type-label text-text-2">
                  Mostrar
                </label>
                <select
                  id="penalties-limit"
                  value={penaltiesLimit}
                  onChange={(event) => setPenaltiesLimit(Number(event.target.value))}
                  className="h-8 rounded-sm border border-border bg-surface-2 px-2 text-text focus:border-accent focus:outline-none"
                >
                  <option value={10}>10</option>
                  <option value={30}>30</option>
                  <option value={100}>100</option>
                </select>
              </div>
            ) : undefined
          }
        >
          {!penaltiesDbConfigured ? (
            <EmptyState
              icon={Gavel}
              title="Historial no disponible."
              description="La moderación funciona, pero el historial de penalidades no está configurado en el backend."
            />
          ) : penaltiesState === "error" ? (
            <EmptyState
              icon={WifiOff}
              title="No pudimos cargar el historial."
              description={penaltiesError ?? "Comprueba tu conexión e inténtalo de nuevo."}
            />
          ) : penaltiesState === "loading" ? (
            <div aria-hidden="true" className="space-y-3">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex items-center justify-between gap-4">
                  <Skeleton className="h-3" style={{ width: `${70 - index * 12}%` }} />
                  <Skeleton className="h-3 w-10" />
                </div>
              ))}
            </div>
          ) : penalties.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Aún no hay penalidades."
              description="Cuando la moderación emita un warn, kick o ban, quedará registrado aquí."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <caption className="sr-only">
                  Historial de penalidades de la comunidad, más recientes primero.
                </caption>
                <thead>
                  <tr className="bg-surface">
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Tipo</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Ofensor</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Autor</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Motivo</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right">
                      <span className="type-label text-text-2">Fecha</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right">
                      <span className="type-label text-text-2">Vence</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right">
                      <span className="type-label text-text-2">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {penalties.map((penalty) => (
                    <tr
                      key={penalty.id}
                      className="h-[44px] border-b border-border transition-colors duration-150 ease-out last:border-b-0 hover:bg-surface-2"
                    >
                      <td className="px-3 py-2.5">
                        <PenaltyTypeBadge type={penalty.type} />
                      </td>
                      <td className="max-w-[160px] truncate px-3 py-2.5">
                        <span className="block truncate text-sm font-semibold text-text" title={penalty.offender?.name ?? ""}>
                          {stripColorCodes(penalty.offender?.name ?? null)}
                        </span>
                        {penalty.offender && (
                          <span className="type-caption block text-text-2">#{penalty.offender.clientId}</span>
                        )}
                      </td>
                      <td className="max-w-[160px] truncate px-3 py-2.5">
                        <span className="block truncate text-sm font-semibold text-text" title={penalty.punisher?.name ?? ""}>
                          {penalty.punisher ? stripColorCodes(penalty.punisher.name) : penalty.automated ? "Automática" : "—"}
                        </span>
                      </td>
                      <td className="max-w-[280px] px-3 py-2.5">
                        <span className="type-body block text-text">{penalty.reason ?? "—"}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className="type-caption whitespace-nowrap text-text-2">
                          {formatRelative(penalty.when)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className="type-caption whitespace-nowrap text-text-2">
                          {penalty.expires ? formatRelative(penalty.expires) : "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {canUnban(penalty) ? (
                          <div className="flex flex-col items-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void handleUnban(penalty)}
                              disabled={unbanBusyId !== null}
                              loading={unbanBusyId === penalty.id}
                              aria-label={`Levantar ban de ${stripColorCodes(penalty.offender?.name ?? null)}`}
                            >
                              <ShieldOff size={14} strokeWidth={1.75} aria-hidden="true" />
                              Levantar ban
                            </Button>
                            {unbanError?.id === penalty.id && (
                              <p role="alert" className="type-caption max-w-[220px] text-danger-hover">
                                {unbanError.text}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="type-caption text-text-2">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Bans del server (bans.json, solo lectura) */}
        <Panel
          title="Bans del server"
          caption={
            bansState === "ready" && bansData
              ? `${formatInt(bansCount)} ${bansCount === 1 ? "ban permanente" : "bans permanentes"} en bans.json — los aplica el propio server y sobreviven reinicios.`
              : "Los bans permanentes los aplica el propio server (bans.json) y sobreviven reinicios."
          }
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setBansOpen((open) => !open)}
              aria-expanded={bansOpen}
            >
              {bansOpen ? (
                <ChevronUp size={16} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
              )}
              {bansOpen ? "Ocultar" : "Ver lista"}
            </Button>
          }
        >
          {bansOpen && (
            bansState === "error" ? (
              <EmptyState
                icon={WifiOff}
                title="No pudimos leer los bans del server."
                description={bansError ?? "Comprueba tu conexión e inténtalo de nuevo."}
                action={
                  <Button size="sm" variant="ghost" onClick={() => setBansReloadKey((key) => key + 1)}>
                    Reintentar
                  </Button>
                }
              />
            ) : bansState === "loading" ? (
              <div className="flex items-center gap-2">
                <Spinner size={16} />
                <span className="type-caption text-text-2">Leyendo bans.json del server…</span>
              </div>
            ) : bansData && !bansData.configured ? (
              <EmptyState
                icon={ShieldAlert}
                title="Bans del server no disponibles."
                description="El backend no tiene configurada la ruta del archivo bans.json (RCON_BANS_FILE)."
              />
            ) : bansData && bansCount === 0 ? (
              <EmptyState
                icon={Inbox}
                title="El server no tiene bans permanentes ahora."
                description="Cuando apliques un ban permanente desde este panel o desde la consola del juego, quedará en bans.json y sobrevivirá a los reinicios."
              />
            ) : bansData && bansData.exists === false ? (
              <EmptyState
                icon={Inbox}
                title="El server todavía no tiene archivo de bans."
                description="bans.json se crea con el primer ban permanente. Los bans que apliques desde el panel quedarán registrados allí."
              />
            ) : bansData && bansData.bans.length > 0 ? (
              <ul className="divide-y divide-border">
                {bansData.bans.map((ban, index) => (
                  <li key={`${ban.kind}-${ban.value}-${index}`} className="flex flex-wrap items-center gap-2 py-2.5 first:pt-0 last:pb-0">
                    <Badge variant={ban.kind === "guid" ? "neutral" : "warning"}>
                      {ban.kind === "guid" ? "GUID" : "IP"}
                    </Badge>
                    <span className="type-mono text-text">{ban.value}</span>
                    {ban.kind === "guid" && ban.guidDecimal && (
                      <span className="type-caption text-text-2">decimal: {ban.guidDecimal}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null
          )}
        </Panel>
      </div>

      {penaltyModal && (
        <PenaltyModal
          target={penaltyModal.target}
          type={penaltyModal.type}
          allowTypeChoice={penaltyModal.allowTypeChoice}
          onClose={() => setPenaltyModal(null)}
          onDone={handlePenaltyDone}
        />
      )}
    </div>
  );
}
