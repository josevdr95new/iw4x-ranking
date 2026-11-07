import {
  AlertCircle,
  Check,
  CircleAlert,
  Gavel,
  Inbox,
  RefreshCcw,
  Search,
  SearchX,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../../lib/api";
import type {
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

const PENALTY_LABEL_TO_TYPE: Array<{ type: IamPenaltyType; label: string }> = [
  { type: "warn", label: "WARN" },
  { type: "kick", label: "KICK" },
  { type: "tempban", label: "TEMPBAN" },
  { type: "ban", label: "BAN" },
];

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

/* --- Panel principal --- */

type StatusState =
  | { phase: "loading" }
  | { phase: "unreachable"; error: string | null }
  | { phase: "ready"; status: IamStatusResponse; checkedAt: number };

export function ModerationPanel() {
  const [statusState, setStatusState] = useState<StatusState>({ phase: "loading" });
  const [statusReloadKey, setStatusReloadKey] = useState(0);

  const [live, setLive] = useState<IamLiveResponse | null>(null);
  const [liveState, setLiveState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const [clientQueryInput, setClientQueryInput] = useState("");
  const [clientResults, setClientResults] = useState<Awaited<ReturnType<typeof api.iamClients>> | null>(null);
  const [clientState, setClientState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [clientsError, setClientsError] = useState<string | null>(null);

  const [penalties, setPenalties] = useState<IamPenalty[]>([]);
  const [penaltiesState, setPenaltiesState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [penaltiesError, setPenaltiesError] = useState<string | null>(null);
  const [penaltiesLimit, setPenaltiesLimit] = useState(30);
  const [penaltiesReloadKey, setPenaltiesReloadKey] = useState(0);

  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [penaltyModal, setPenaltyModal] = useState<{ target: PenaltyTarget; type: IamPenaltyType } | null>(null);

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
        .catch(() => {
          if (!cancelled) setLiveState("error");
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

  const refreshAfterPenalty = useCallback(() => {
    setLiveState("loading");
    api
      .iamLive()
      .then((response) => {
        setLive(response);
        setLiveState("ready");
      })
      .catch(() => setLiveState("error"));
    setPenaltiesReloadKey((key) => key + 1);
  }, []);

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

  const liveTotals = useMemo(() => {
    if (!live) return null;
    const online = live.servers.filter((server) => server.online).length;
    const players = live.servers.reduce((count, server) => count + server.players.length, 0);
    return { servers: live.servers.length, online, players };
  }, [live]);

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
          <h2 className="type-display-m text-warning">
            IW4MAdmin sin conexión — moderación deshabilitada
          </h2>
          <p className="type-body mt-1 max-w-[68ch] text-text-2">
            {statusState.error ??
              "No se pudo contactar el webfront de IW4MAdmin. Revisa que esté corriendo y vuelve a intentarlo."}
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

  return (
    <div>
      {/* Estado del bridge */}
      <div
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-surface px-4 py-3"
      >
        <span className="type-label inline-flex items-center gap-2 text-accent">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
          Puente IW4MAdmin conectado
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
              onClick={() => {
                setLiveState("loading");
                api
                  .iamLive()
                  .then((response) => {
                    setLive(response);
                    setLiveState("ready");
                  })
                  .catch(() => setLiveState("error"));
              }}
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
              description="El webfront de IW4MAdmin no respondió. Vuelve a intentarlo en unos segundos."
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
              title="No hay jugadores conectados ahora."
              description="Cuando alguien entre al server aparecerá aquí, con sus datos en vivo."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <caption className="sr-only">
                  Jugadores conectados ahora en los servers monitorizados por IW4MAdmin.
                </caption>
                <thead>
                  <tr className="bg-surface">
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Jugador</span>
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
                      const actionable = player.clientId !== null;
                      const key = `${server.id}-${index}-${stripColorCodes(player.name)}`;
                      return (
                        <tr
                          key={key}
                          className="h-[44px] border-b border-border transition-colors duration-150 ease-out last:border-b-0 hover:bg-surface-2"
                        >
                          <td className="max-w-[220px] px-3 py-2.5">
                                        <span className="block truncate text-sm font-semibold text-text" title={player.name}>
                              {stripColorCodes(player.name)}
                            </span>
                            {!actionable && (
                              <span className="type-caption block text-text-2">
                                sin clientId resuelto
                              </span>
                            )}
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
                            <span className="type-caption text-text-2">{player.state}</span>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            {actionable ? (
                              <div className="inline-flex items-center gap-1">
                                {PENALTY_LABEL_TO_TYPE.map((entry) => (
                                  <button
                                    key={entry.type}
                                    type="button"
                                    onClick={() =>
                                      setPenaltyModal({
                                        target: { clientId: player.clientId as number, name: player.name },
                                        type: entry.type,
                                      })
                                    }
                                    title={`${entry.label} para ${stripColorCodes(player.name)}`}
                                    className={`type-button h-8 rounded-sm px-2 text-[12px] transition-colors duration-150 ease-out ${
                                      entry.type === "warn"
                                        ? "text-warning hover:bg-warning/10"
                                        : entry.type === "kick"
                                          ? "text-text-2 hover:bg-surface-2 hover:text-text"
                                          : "text-danger-hover hover:bg-danger/10"
                                    }`}
                                  >
                                    {entry.label}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <span className="type-caption text-text-2" title="El nombre no se pudo resolver contra la base de clientes">
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
                            Penalidades abiertas no disponibles (falta la DB de iw4madmin).
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
              : "El historial no está disponible: falta configurar la DB de penalidades (IW4MADMIN_PENALTIES_DB_PATH)."
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
              description="El puente funciona, pero la DB de penalidades de IW4MAdmin no está configurada en el backend."
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
                          {penalty.punisher ? stripColorCodes(penalty.punisher.name) : "Automática"}
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {penaltyModal && (
        <PenaltyModal
          target={penaltyModal.target}
          type={penaltyModal.type}
          onClose={() => setPenaltyModal(null)}
          onDone={handlePenaltyDone}
        />
      )}
    </div>
  );
}

