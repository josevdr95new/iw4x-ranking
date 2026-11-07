import {
  Check,
  CircleAlert,
  Inbox,
  RefreshCcw,
  ServerCrash,
  ShieldCheck,
  UserCog,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../../lib/api";
import type {
  AliasConflictsResponse,
  IamPenaltyType,
  IdentityAlert,
  IdentityAlertsResponse,
  NameCollision,
  SharedGuid,
} from "../../lib/api";
import { PenaltyModal, PENALTY_TYPE_LABEL, stripColorCodes } from "../../components/PenaltyModal";
import type { PenaltyTarget } from "../../components/PenaltyModal";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Panel } from "../../components/ui/Panel";
import { Skeleton, Spinner } from "../../components/ui/Spinner";
import { formatGuid, formatInt, formatRelative } from "../../lib/format";

type AlertStatusFilter = "OPEN" | "RESOLVED_OWNER" | "RESOLVED_IMPOSTOR" | "DISMISSED" | "ALL";

const STATUS_FILTER_LABEL: Record<AlertStatusFilter, string> = {
  OPEN: "Abiertas",
  RESOLVED_OWNER: "Resueltas (dueño)",
  RESOLVED_IMPOSTOR: "Resueltas (impostor)",
  DISMISSED: "Descartadas",
  ALL: "Todas",
};

const STATUS_BADGE: Record<string, { label: string; variant: "warning" | "success" | "danger" | "neutral" }> = {
  OPEN: { label: "ABIERTA", variant: "warning" },
  RESOLVED_OWNER: { label: "RESUELTA · DUEÑO", variant: "success" },
  RESOLVED_IMPOSTOR: { label: "RESUELTA · IMPOSTOR", variant: "danger" },
  DISMISSED: { label: "DESCARTADA", variant: "neutral" },
};

const DEFAULT_PENALTY_TYPE: IamPenaltyType = "kick";

/** Motivo por defecto del castigo a un impersonador (editable en el modal). */
function impersonationReason(ownerDisplayName: string): string {
  return `Nick reservado de ${ownerDisplayName} — identidad no verificada`;
}

type LoadState = "loading" | "not-deployed" | "error" | "ready";

interface RowError {
  id: IdentityAlert["id"];
  text: string;
}

/** Banner compartido: el backend aún no despliega el módulo de identidad (404). */
function NotDeployedBanner({ onRetry, endpoint }: { onRetry: () => void; endpoint: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-4"
    >
      <ServerCrash size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <h3 className="type-display-m text-warning">Backend aún no desplegado</h3>
        <p className="type-body mt-1 max-w-[68ch] text-text-2">
          El endpoint <span className="type-mono">{endpoint}</span> todavía no responde en el
          servidor. Cuando termine el despliegue del módulo de identidad, esta sección se activará
          sola.
        </p>
        <Button size="sm" variant="ghost" className="mt-3" onClick={onRetry}>
          <RefreshCcw size={16} strokeWidth={1.75} aria-hidden="true" />
          Reintentar
        </Button>
      </div>
    </div>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  const widths = [70, 55, 80, 45];
  return (
    <div aria-hidden="true" className="space-y-3">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-4">
          <Skeleton className="h-3" style={{ width: `${widths[index % widths.length]}%` }} />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

/* --- Alertas de identidad --- */

function AlertsSection() {
  const [statusFilter, setStatusFilter] = useState<AlertStatusFilter>("OPEN");
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<IdentityAlertsResponse | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [linkingId, setLinkingId] = useState<IdentityAlert["id"] | null>(null);
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  /** Flujo castigar: la búsqueda del cliente IW4MAdmin se resuelve antes de abrir el modal. */
  const [pendingPunish, setPendingPunish] = useState<
    | { phase: "resolving"; alert: IdentityAlert }
    | { phase: "modal"; alert: IdentityAlert; target: PenaltyTarget }
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    setState((current) => (current === "ready" ? "ready" : "loading"));
    setErrorText(null);
    api
      .identityAlerts(statusFilter === "ALL" ? undefined : statusFilter)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setState("not-deployed");
        } else {
          setState("error");
          setErrorText(
            error instanceof ApiError ? error.message : "No se pudieron cargar las alertas.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, reloadKey]);

  const handleLink = useCallback(
    async (alert: IdentityAlert) => {
      setLinkingId(alert.id);
      setRowError(null);
      setNotice(null);
      try {
        await api.resolveIdentityAlert(alert.id, "LINK_TO_OWNER");
        setNotice({
          ok: true,
          text: `«${stripColorCodes(alert.name)}» quedó vinculado a ${alert.owner.displayName} (${alert.owner.email}).`,
        });
        setReloadKey((key) => key + 1);
      } catch (error) {
        setRowError({
          id: alert.id,
          text:
            error instanceof ApiError
              ? error.message
              : "No se pudo vincular el nick a su dueño. Inténtalo de nuevo.",
        });
      } finally {
        setLinkingId(null);
      }
    },
    [],
  );

  const handlePunish = useCallback(async (alert: IdentityAlert) => {
    setRowError(null);
    setNotice(null);
    setPendingPunish({ phase: "resolving", alert });
    try {
      const cleanNick = stripColorCodes(alert.name);
      const response = await api.iamClients(cleanNick);
      const matches = response.clients;
      if (matches.length === 1) {
        const client = matches[0];
        setPendingPunish({
          phase: "modal",
          alert,
          target: { clientId: client.clientId, name: client.name },
        });
      } else if (matches.length === 0) {
        setPendingPunish(null);
        setRowError({
          id: alert.id,
          text: `No hay ningún cliente de IW4MAdmin con el nick «${cleanNick}». Búscalo por otro nombre en la pestaña Moderación para actuar manualmente.`,
        });
      } else {
        setPendingPunish(null);
        setRowError({
          id: alert.id,
          text: `El nick «${cleanNick}» coincide con ${formatInt(matches.length)} clientes de IW4MAdmin. Resuélvelo desde la pestaña Moderación.`,
        });
      }
    } catch (error) {
      setPendingPunish(null);
      setRowError({
        id: alert.id,
        text:
          error instanceof ApiError && error.status !== 503
            ? error.message
            : "No se pudo consultar la base de clientes de IW4MAdmin.",
      });
    }
  }, []);

  const handlePunishDone = useCallback(async () => {
    const current = pendingPunish;
    setPendingPunish(null);
    if (!current || current.phase !== "modal") return;
    const { alert, target } = current;
    setNotice({
      ok: true,
      text: `${PENALTY_TYPE_LABEL[DEFAULT_PENALTY_TYPE]} emitido a ${stripColorCodes(target.name)} (#${target.clientId}). Descartando la alerta…`,
    });
    try {
      await api.resolveIdentityAlert(alert.id, "DISMISS");
    } catch {
      setNotice({
        ok: false,
        text: "El castigo se emitió, pero no se pudo descartar la alerta automáticamente. Descártala a mano.",
      });
    }
    setReloadKey((key) => key + 1);
  }, [pendingPunish]);

  const alerts = data?.alerts ?? [];

  return (
    <Panel
      title="Alertas de identidad"
      caption="Alguien juega con el nick reservado de una cuenta web. Verifica si es el dueño o un impersonador."
      action={
        <div className="flex items-center gap-2">
          <label htmlFor="identity-status-filter" className="type-label text-text-2">
            Estado
          </label>
          <select
            id="identity-status-filter"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as AlertStatusFilter)}
            className="h-8 rounded-sm border border-border bg-surface-2 px-2 text-text focus:border-accent focus:outline-none"
          >
            {(Object.keys(STATUS_FILTER_LABEL) as AlertStatusFilter[]).map((value) => (
              <option key={value} value={value}>
                {STATUS_FILTER_LABEL[value]}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={state === "loading"}
            aria-label="Actualizar alertas"
          >
            {state === "loading" ? <Spinner size={14} /> : <RefreshCcw size={16} strokeWidth={1.75} aria-hidden="true" />}
            Actualizar
          </Button>
        </div>
      }
    >
      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-4 flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm ${
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
          <p className="min-w-0 flex-1 break-words">{notice.text}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Descartar aviso"
            className="shrink-0 opacity-70 transition-colors duration-150 ease-out hover:opacity-100"
          >
            <span aria-hidden="true" className="text-base leading-none">×</span>
          </button>
        </div>
      )}

      {state === "not-deployed" ? (
        <NotDeployedBanner
          endpoint="GET /api/admin/identity-alerts"
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      ) : state === "error" ? (
        <EmptyState
          icon={WifiOff}
          title="No pudimos cargar las alertas."
          description={errorText ?? "Comprueba tu conexión e inténtalo de nuevo."}
          action={
            <Button onClick={() => setReloadKey((key) => key + 1)}>Reintentar</Button>
          }
        />
      ) : state === "loading" ? (
        <ListSkeleton rows={3} />
      ) : alerts.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Sin alertas de identidad — todo en orden."
          description="Cuando alguien juegue con un nick reservado por otra cuenta, aparecerá aquí para revisarlo."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <caption className="sr-only">
              Alertas de identidad: usos del juego de nicks reservados por cuentas web.
            </caption>
            <thead>
              <tr className="bg-surface">
                <th scope="col" className="px-3 py-2.5 text-left">
                  <span className="type-label text-text-2">Nick reclamado</span>
                </th>
                <th scope="col" className="px-3 py-2.5 text-left">
                  <span className="type-label text-text-2">GUID</span>
                </th>
                <th scope="col" className="px-3 py-2.5 text-right">
                  <span className="type-label text-text-2">Apariciones</span>
                </th>
                <th scope="col" className="px-3 py-2.5 text-right">
                  <span className="type-label text-text-2">Últ. vez</span>
                </th>
                <th scope="col" className="px-3 py-2.5 text-left">
                  <span className="type-label text-text-2">Dueño</span>
                </th>
                <th scope="col" className="px-3 py-2.5 text-right">
                  <span className="type-label text-text-2">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => {
                const badge = STATUS_BADGE[alert.status];
                const nick = stripColorCodes(alert.name);
                return (
                  <tr
                    key={alert.id}
                    className="h-[52px] border-b border-border align-top transition-colors duration-150 ease-out last:border-b-0 hover:bg-surface-2"
                  >
                    <td className="px-3 py-2.5">
                      <span className="block text-sm font-semibold text-text" title={alert.name}>
                        {nick}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5">
                        {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
                      </span>
                      {rowError && rowError.id === alert.id && (
                        <p role="alert" className="mt-1.5 max-w-[36ch] text-[13px] text-danger-hover">
                          {rowError.text}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="type-mono whitespace-nowrap text-text-2" title={alert.guid}>
                        {formatGuid(alert.guid)}
                      </span>
                    </td>
                    <td data-numeric className="px-3 py-2.5 text-right">
                      <span className="type-number-m text-text">{formatInt(alert.occurrences)}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <span className="type-caption text-text-2">{formatRelative(alert.lastSeenAt)}</span>
                    </td>
                    <td className="max-w-[220px] px-3 py-2.5">
                      <span className="block truncate text-sm font-medium text-text" title={alert.owner.displayName}>
                        {alert.owner.displayName}
                      </span>
                      <span className="type-mono block truncate text-[12px] text-text-2" title={alert.owner.email}>
                        {alert.owner.email}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col items-end gap-1.5">
                        <Button
                          size="sm"
                          onClick={() => void handleLink(alert)}
                          disabled={linkingId !== null}
                          loading={linkingId === alert.id}
                        >
                          <UserCog size={14} strokeWidth={1.75} aria-hidden="true" />
                          Es el dueño → vincular
                        </Button>
                        <button
                          type="button"
                          onClick={() => void handlePunish(alert)}
                          disabled={linkingId !== null || pendingPunish !== null}
                          className="type-button inline-flex h-8 items-center gap-2 rounded-sm px-3 text-warning transition-colors duration-150 ease-out hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {pendingPunish?.phase === "resolving" && pendingPunish.alert.id === alert.id ? (
                            <Spinner size={14} />
                          ) : (
                            <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
                          )}
                          Impersonador → castigar
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pendingPunish?.phase === "modal" && (
        <PenaltyModal
          target={pendingPunish.target}
          type={DEFAULT_PENALTY_TYPE}
          initialReason={impersonationReason(pendingPunish.alert.owner.displayName)}
          onClose={() => setPendingPunish(null)}
          onDone={() => void handlePunishDone()}
        />
      )}
    </Panel>
  );
}

/* --- Conflictos de alias (read-only) --- */

function BotToggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-text-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-accent"
      />
      Ocultar bots
    </label>
  );
}

function SeverityBadge({ severity }: { severity: "high" | "low" }) {
  return severity === "high" ? (
    <Badge variant="danger">GRAVE</Badge>
  ) : (
    <Badge variant="neutral">BAJA</Badge>
  );
}

function BotBadge() {
  return (
    <Badge variant="neutral" className="text-text-2">
      BOT
    </Badge>
  );
}

/** Orden defensivo: graves primero (la API ya viene ordenada; no se depende de ello). */
function bySeverityFirst(collisions: NameCollision[]): NameCollision[] {
  return [...collisions].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
}

function ConflictsSection() {
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<AliasConflictsResponse | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [hideBots, setHideBots] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((current) => (current === "ready" ? "ready" : "loading"));
    setErrorText(null);
    api
      .aliasConflicts()
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setState("not-deployed");
        } else {
          setState("error");
          setErrorText(
            error instanceof ApiError ? error.message : "No se pudieron cargar los conflictos.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const filtered = useMemo(() => {
    if (!data) return { collisions: [] as NameCollision[], shared: [] as SharedGuid[], hadHidden: false };
    const collisions = hideBots
      ? data.nameCollisions
          .map((collision) => ({
            ...collision,
            guids: collision.guids.filter((guid) => !guid.isBot),
          }))
          .filter((collision) => collision.guids.length >= 2)
      : data.nameCollisions;
    const shared = hideBots ? data.sharedGuids.filter((entry) => !entry.isBot) : data.sharedGuids;
    const hadHidden =
      data.nameCollisions.length > 0 || data.sharedGuids.length > 0
        ? collisions.length === 0 && shared.length === 0
        : false;
    return { collisions: bySeverityFirst(collisions), shared, hadHidden };
  }, [data, hideBots]);

  return (
    <Panel
      title="Conflictos de alias"
      caption="Nombres compartidos entre GUIDs y guids con varios alias. Solo lectura: sirve para desambiguar, no para castigar."
      action={<BotToggle checked={hideBots} onChange={setHideBots} />}
    >
      {state === "not-deployed" ? (
        <NotDeployedBanner
          endpoint="GET /api/admin/alias-conflicts"
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      ) : state === "error" ? (
        <EmptyState
          icon={WifiOff}
          title="No pudimos cargar los conflictos."
          description={errorText ?? "Comprueba tu conexión e inténtalo de nuevo."}
          action={<Button onClick={() => setReloadKey((key) => key + 1)}>Reintentar</Button>}
        />
      ) : state === "loading" ? (
        <ListSkeleton rows={4} />
      ) : filtered.collisions.length === 0 && filtered.shared.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={
            filtered.hadHidden
              ? "Todos los conflictos detectados implican bots."
              : "Sin conflictos de alias detectados."
          }
          description={
            filtered.hadHidden
              ? "Los bots rotan nombres de una pool cada partida y generan ruido. Desactiva «Ocultar bots» para verlos."
              : "Cuando dos GUIDs usen el mismo nombre o un guid acumule renombres, aparecerá aquí."
          }
        />
      ) : (
        <div className="space-y-6">
          {filtered.collisions.length > 0 && (
            <section aria-label="Colisiones de nombre">
              <h3 className="type-label text-text-2">Colisiones de nombre</h3>
              <ul className="mt-2 divide-y divide-border">
                {filtered.collisions.map((collision) => (
                  <li key={collision.nameKey} className="py-4 first:pt-2 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-text">{collision.displayName}</span>
                      <SeverityBadge severity={collision.severity} />
                      <span className="type-caption text-text-2">
                        {formatInt(collision.distinctAccounts)}{" "}
                        {collision.distinctAccounts === 1 ? "cuenta distinta" : "cuentas distintas"} ·{" "}
                        {formatInt(collision.guids.length)}{" "}
                        {collision.guids.length === 1 ? "GUID" : "GUIDs"}
                      </span>
                    </div>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full">
                        <caption className="sr-only">
                          GUIDs que usan el nombre {collision.displayName}.
                        </caption>
                        <thead>
                          <tr className="bg-surface">
                            <th scope="col" className="px-3 py-2 text-left">
                              <span className="type-label text-text-2">GUID</span>
                            </th>
                            <th scope="col" className="px-3 py-2 text-left">
                              <span className="type-label text-text-2">Nombre</span>
                            </th>
                            <th scope="col" className="px-3 py-2 text-left">
                              <span className="type-label text-text-2">Cuenta</span>
                            </th>
                            <th scope="col" className="px-3 py-2 text-right">
                              <span className="type-label text-text-2">Apariciones</span>
                            </th>
                            <th scope="col" className="px-3 py-2 text-right">
                              <span className="type-label text-text-2">Últ. vez</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {collision.guids.map((guid) => (
                            <tr
                              key={guid.guid}
                              className="h-[40px] border-b border-border last:border-b-0"
                            >
                              <td className="whitespace-nowrap px-3 py-2">
                                <span className="type-mono text-text-2" title={guid.guid}>
                                  {formatGuid(guid.guid)}
                                </span>
                              </td>
                              <td className="max-w-[180px] truncate px-3 py-2">
                                <span className="text-sm text-text" title={guid.name}>
                                  {stripColorCodes(guid.name)}{" "}
                                  {guid.isBot && <BotBadge />}
                                </span>
                              </td>
                              <td className="max-w-[220px] truncate px-3 py-2">
                                {guid.linkedEmail ? (
                                  <span
                                    className="type-mono block truncate text-[12px] text-text-2"
                                    title={`${guid.linkedEmail} (#${guid.linkedAccountId})`}
                                  >
                                    {guid.linkedEmail}
                                  </span>
                                ) : (
                                  <span className="type-caption text-text-2">sin cuenta</span>
                                )}
                              </td>
                              <td data-numeric className="px-3 py-2 text-right">
                                <span className="type-number-m text-text">{formatInt(guid.occurrences)}</span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-right">
                                <span className="type-caption text-text-2">{formatRelative(guid.lastSeenAt)}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {filtered.shared.length > 0 && (
            <section aria-label="GUIDs con varios alias">
              <h3 className="type-label text-text-2">GUIDs con varios alias</h3>
              <ul className="mt-2 divide-y divide-border">
                {filtered.shared.map((entry) => (
                  <li key={entry.guid} className="py-3 first:pt-2 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="type-mono whitespace-nowrap text-text-2" title={entry.guid}>
                        {formatGuid(entry.guid)}
                      </span>
                      <span className="text-sm font-semibold text-text">{stripColorCodes(entry.name)}</span>
                      {entry.isBot && <BotBadge />}
                      <span className="type-caption text-text-2">
                        {formatInt(entry.aliasCount)} {entry.aliasCount === 1 ? "alias" : "aliases"}
                      </span>
                    </div>
                    <p className="type-mono mt-1.5 break-words text-[12px] text-text-2">
                      {entry.aliases.map((alias, index) => (
                        <span key={alias.name}>
                          {index > 0 && " · "}
                          {alias.name} ({formatInt(alias.occurrences)}×, {formatRelative(alias.lastSeenAt)})
                        </span>
                      ))}
                      {entry.aliasCount > entry.aliases.length && (
                        <span className="text-text-2"> …y {entry.aliasCount - entry.aliases.length} más</span>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data && (
            <p className="type-caption text-text-2">Generado {formatRelative(data.generatedAt)}.</p>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Tab IDENTIDAD: alertas de nick reservado + conflictos de alias. */
export function IdentityPanel() {
  return (
    <div className="space-y-4">
      <AlertsSection />
      <ConflictsSection />
    </div>
  );
}
