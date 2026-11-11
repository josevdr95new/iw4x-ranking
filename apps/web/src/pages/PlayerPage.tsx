import { ArrowLeft, CloudUpload, Inbox, Info, RefreshCcw, ShieldAlert, UserX, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../lib/api";
import type { KillEvent, PlayerDetail, ProfileSaveResponse } from "../lib/api";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Skeleton, Spinner } from "../components/ui/Spinner";
import { MedalBadge } from "../components/MedalBadge";
import { useAuth } from "../lib/auth";
import {
  formatDecimal,
  formatDuration,
  formatFullDate,
  formatInt,
  formatMemberSince,
  formatRelative,
  formatSkill,
  formatTimestamp,
  initialsOf,
  isOnline,
} from "../lib/format";

function PlayerSkeleton() {
  return (
    <div aria-hidden="true" className="rounded-md border border-border bg-surface">
      <div className="flex items-center gap-4 p-6">
        <Skeleton className="h-16 w-16" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-3 w-72" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-px border-t border-border bg-border lg:grid-cols-10">
        {Array.from({ length: 10 }, (_, index) => (
          <div key={index} className="bg-surface p-4">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="mt-3 h-6 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Tag inline estilo mono del tema (igual que el tag BOT de la moderación). */
function EventTag({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="type-mono inline-flex h-[18px] items-center rounded-none border border-border px-1.5 text-[10px] leading-none text-text-2"
    >
      {label}
    </span>
  );
}

/**
 * Variantes que llegan como PREFIJO del código en logs/mods viejos (el diccionario
 * solo trae códigos base y el attachment infix "_gl_"): "gl_famas" → base "famas".
 * Solo prefijos vistos en datos reales del feed.
 */
const WEAPON_CODE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["gl_", " + Lanzagranadas"],
];

/**
 * Arma del feed: SIEMPRE nombre humano (weaponName del evento; si una API previa
 * no lo trae, se decodifica con el diccionario público; el crudo es último recurso).
 */
function weaponDisplay(event: KillEvent, dictionary: Map<string, string>): string {
  if (event.weaponName) return event.weaponName;
  const code = event.weaponCode ?? event.weapon;
  if (!code) return "—";
  // Prefijo de variante (ej. "gl_famas"): se decodifica la base con el diccionario
  // y la variante va al final → "FAMAS + Lanzagranadas" (nunca "Gl Famas").
  for (const [prefix, suffix] of WEAPON_CODE_PREFIXES) {
    if (code.startsWith(prefix)) {
      const baseCode = code.slice(prefix.length).replace(/_mp$/, "");
      return `${dictionary.get(baseCode) ?? baseCode}${suffix}`;
    }
  }
  return dictionary.get(code) ?? code;
}

function ActivityTable({ detail, weaponNames }: { detail: PlayerDetail; weaponNames: Map<string, string> }) {
  const events = detail.recentEvents;

  if (events.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface">
        <EmptyState
          icon={Inbox}
          title="Sin partidas recientes."
          description={`Cuando ${detail.player.name} entre a un servidor, verás su actividad aquí.`}
        />
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full">
        <caption className="sr-only">
          Actividad reciente de {detail.player.name}: bajas y muertes registradas por los servidores.
        </caption>
        <thead>
          <tr className="bg-surface">
            <th scope="col" className="px-3 py-2.5 text-left">
              <span className="type-label text-text-2">Fecha</span>
            </th>
            <th scope="col" className="px-3 py-2.5 text-left">
              <span className="type-label text-text-2">Evento</span>
            </th>
            <th scope="col" className="px-3 py-2.5 text-left">
              <span className="type-label text-text-2">Rival</span>
            </th>
            <th scope="col" className="px-3 py-2.5 text-left">
              <span className="type-label text-text-2">Arma</span>
            </th>
            <th scope="col" className="hidden px-3 py-2.5 text-left lg:table-cell">
              <span className="type-label text-text-2">Servidor</span>
            </th>
            <th scope="col" className="hidden px-3 py-2.5 text-right lg:table-cell">
              <span className="type-label text-text-2">Daño</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const isKill = event.direction === "kill";
            return (
              <tr key={event.id} className="h-[44px] border-b border-border last:border-b-0 transition-colors duration-150 ease-out hover:bg-surface-2">
                <td className="whitespace-nowrap px-3 py-2.5">
                  <span className="type-caption text-text-2 lg:hidden">{formatRelative(event.time)}</span>
                  <span className="hidden text-sm text-text lg:inline">{formatTimestamp(event.time)}</span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isKill ? (
                      <Badge variant="success">Baja</Badge>
                    ) : (
                      <Badge variant="danger">Muerte</Badge>
                    )}
                    {event.headshot && <EventTag label="HS" title="Baja con tiro a la cabeza" />}
                    {event.isKnife && <EventTag label="CUCHILLO" title="Baja o muerte a cuchillo" />}
                  </div>
                </td>
                <td className="max-w-[180px] truncate px-3 py-2.5">
                  {event.opponentGuid ? (
                    <Link
                      to={`/player/${event.opponentGuid}`}
                      className="text-sm font-semibold text-text transition-colors duration-150 ease-out hover:text-accent"
                    >
                      {event.opponentName ?? "—"}
                    </Link>
                  ) : (
                    <span className="text-sm text-text-2">{event.opponentName ?? "—"}</span>
                  )}
                </td>
                <td className="max-w-[220px] truncate px-3 py-2.5" title={weaponDisplay(event, weaponNames)}>
                  <span className="text-sm text-text">{weaponDisplay(event, weaponNames)}</span>
                </td>
                <td className="hidden px-3 py-2.5 lg:table-cell">
                  <span className="type-mono text-text-2">{event.server ?? "—"}</span>
                </td>
                <td data-numeric className="hidden px-3 py-2.5 text-right lg:table-cell">
                  <span className="type-number-m text-text">{formatInt(event.damage)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Bloque MI NUBE: solo para el perfil propio (algún GUID vinculado a la sesión). */
function CloudSavePanel() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [save, setSave] = useState<ProfileSaveResponse | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    api
      .mySave()
      .then((response) => {
        if (cancelled) return;
        setSave(response);
        setState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <section aria-label="Mi nube" className="mt-4 rounded-md border border-border bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-3">
        <h2 className="type-display-m text-text">Mi nube</h2>
        {state === "ready" && save !== null && save.exists && (
          <Badge variant="neutral">versión {formatInt(save.version)}</Badge>
        )}
      </header>
      <div className="flex items-start gap-3 px-5 py-4" aria-live="polite">
        <CloudUpload size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-text-2" />
        {state === "loading" && (
          <p className="type-body flex items-center gap-2 text-text-2">
            <Spinner size={16} />
            Comprobando tu copia en la nube…
          </p>
        )}
        {state === "error" && (
          <div className="min-w-0 flex-1">
            <p className="type-body text-text-2">No pudimos comprobar tu copia en la nube.</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setReloadKey((key) => key + 1)}>
              <RefreshCcw size={14} strokeWidth={1.75} aria-hidden="true" />
              Reintentar
            </Button>
          </div>
        )}
        {state === "ready" && save !== null && (
          save.exists ? (
            <p className="type-body min-w-0 text-text">
              Última copia en la nube: {formatFullDate(save.updatedAt)}
              <span className="text-text-2"> · {formatInt(save.files.length)} archivos · </span>
              <span className="type-mono text-text-2">versión {formatInt(save.version)}</span>
            </p>
          ) : (
            <p className="type-body min-w-0 text-text-2">
              Sin copia en la nube todavía — juega y se guarda solo.
            </p>
          )
        )}
      </div>
    </section>
  );
}

export function PlayerPage() {
  const { guid = "" } = useParams<{ guid: string }>();
  const { user } = useAuth();
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "not-found" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  // Diccionario code→display para el feed (fallback si el evento no trae weaponName).
  const [weaponNames, setWeaponNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    api
      .weaponDictionary()
      .then((dictionary) => {
        if (cancelled) return;
        setWeaponNames(new Map(dictionary.weapons.map((entry) => [entry.code, entry.name])));
      })
      .catch(() => {
        // Sin diccionario el feed sigue funcionando: usa weaponName del evento o el código crudo.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!guid) return;
    let cancelled = false;
    setStatus("loading");

    api
      .player(guid)
      .then((response) => {
        if (cancelled) return;
        setDetail(response);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) setStatus("not-found");
        else setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [guid, reloadKey]);

  if (status === "loading") {
    return (
      <div>
        <Link
          to="/"
          className="type-button inline-flex items-center gap-1.5 text-text-2 transition-colors duration-150 ease-out hover:text-text"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Volver al ranking
        </Link>
        <div className="mt-6">
          <PlayerSkeleton />
        </div>
      </div>
    );
  }

  if (status === "not-found") {
    return (
      <div className="rounded-md border border-border bg-surface">
        <EmptyState
          icon={UserX}
          title="Este jugador no existe."
          description="Puede que nunca haya jugado en nuestros servidores."
          action={
            <Link to="/">
              <Button variant="ghost">Volver al ranking</Button>
            </Link>
          }
        />
      </div>
    );
  }

  if (status === "error" || !detail) {
    return (
      <div className="rounded-md border border-border bg-surface">
        <EmptyState
          icon={WifiOff}
          title="No pudimos cargar el perfil."
          description="Comprueba tu conexión e inténtalo de nuevo."
          action={<Button onClick={() => setReloadKey((key) => key + 1)}>Reintentar</Button>}
        />
      </div>
    );
  }

  const { player } = detail;
  const online = isOnline(player.lastConnection);
  const initials = initialsOf(player.name);

  // Bloque MI NUBE: solo si el perfil visitado pertenece a la cuenta de la sesión.
  const isOwnProfile =
    !!user &&
    (user.linkedGuid === player.guid || user.linkedGuids.some((linked) => linked.guid === player.guid));

  // Headshots: hsRatio (headshots/kills, 2 dec) es el campo nuevo; fallback a headshotPct (API previa).
  const hsRatio = player.hsRatio ?? (player.headshotPct !== null && player.headshotPct !== undefined ? player.headshotPct / 100 : null);
  const hsPercent = hsRatio !== null && hsRatio !== undefined ? Math.round(hsRatio * 100) : null;

  // Nivel real del save en la nube (GSC): null si el jugador no tiene nivel conocido aún.
  const save = player.save ?? null;

  return (
    <div>
      <Link
        to="/"
        className="type-button inline-flex items-center gap-1.5 text-text-2 transition-colors duration-150 ease-out hover:text-text"
      >
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        Volver al ranking
      </Link>

      {/* Hero + stat strip: un solo panel con hairlines (§3.3) */}
      <div className="mt-6 overflow-hidden rounded-md border border-border bg-surface">
        <div className="hero-texture flex flex-col gap-4 p-5 md:flex-row md:items-center md:gap-6 md:p-6">
          <div
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-sm bg-surface-2 font-display text-xl font-bold tracking-[0.04em] text-text-2 md:h-16 md:w-16 md:text-2xl"
          >
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="type-display-xl text-text">{player.name}</h1>
            <p className="type-mono mt-1 text-text-2">GUID: {player.guid}</p>
            {detail.aliases && detail.aliases.length > 0 && (
              <p className="type-mono mt-1 max-w-[68ch] text-[12px] text-text-2">
                También visto como:{" "}
                {detail.aliases.map((alias, index) => (
                  <span key={alias.name}>
                    {index > 0 && ", "}
                    {alias.name} ({formatInt(alias.occurrences)}{" "}
                    {alias.occurrences === 1 ? "vez" : "veces"}, {formatRelative(alias.lastSeenAt)})
                  </span>
                ))}
              </p>
            )}
            <p className="type-caption mt-1 text-text-2">
              Miembro desde {formatMemberSince(player.firstConnection)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-end md:gap-3">
            {/* MEDALLA: la identidad competitiva va primero, junto al rank global. */}
            {detail.medal && (
              <div className="flex flex-col items-start gap-1.5 md:items-end">
                <MedalBadge medal={detail.medal} size="lg" elo={player.skill} showName />
                <p className="type-caption tabular text-text-2">
                  ELO{" "}
                  {player.skill !== null && player.skill !== undefined
                    ? formatInt(Math.round(player.skill))
                    : "—"}
                  {detail.medal.globalRank !== null && detail.medal.globalRank !== undefined && (
                    <> · #{formatInt(detail.medal.globalRank)} global</>
                  )}
                </p>
              </div>
            )}
            {detail.rank !== null && (
              <Badge variant="success">#{formatInt(detail.rank)} global</Badge>
            )}
            {player.linked && (
              <Badge variant="neutral">
                <ShieldAlert size={12} strokeWidth={1.75} aria-hidden="true" />
                Verificado
              </Badge>
            )}
            {online ? (
              <span className="type-label inline-flex items-center gap-1.5 text-accent">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                En línea
              </span>
            ) : (
              <span className="type-label inline-flex items-center gap-1.5 text-text-2">
                <RefreshCcw size={12} strokeWidth={1.75} aria-hidden="true" />
                {formatRelative(player.lastConnection)}
              </span>
            )}
          </div>
        </div>

        {/* Stat strip: celdas con hairlines, NO cards (§3.3). 3×4 en móvil, 10 en fila desde lg. */}
        <dl className="grid grid-cols-3 gap-px border-t border-border bg-border lg:grid-cols-10">
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Nivel</dt>
            {save !== null && save.level !== null && save.level !== undefined ? (
              <>
                <dd className="type-number-l stat-value mt-2 text-text">{formatInt(save.level)}</dd>
                <dd className="type-caption mt-1 text-text-2">
                  {save.prestige > 0 ? `Prestigio ${formatInt(save.prestige)}` : "del save en la nube"}
                </dd>
              </>
            ) : (
              <>
                <dd className="type-number-l stat-value mt-2 text-text-2">—</dd>
                <dd className="type-caption mt-1 text-text-2">sin nivel aún</dd>
              </>
            )}
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Kills</dt>
            <dd className="type-number-l stat-value mt-2 text-text">{formatInt(player.kills)}</dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Muertes</dt>
            <dd className="type-number-l stat-value mt-2 text-text">{formatInt(player.deaths)}</dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Tiros a la cabeza</dt>
            <dd className="type-number-l stat-value mt-2 text-text">{formatInt(player.headshots ?? 0)}</dd>
            <dd className="type-caption mt-1 text-text-2">
              {hsPercent !== null ? `${formatInt(hsPercent)}% de tus bajas` : "sin bajas aún"}
            </dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Cuchillo</dt>
            <dd className="type-number-l stat-value mt-2 text-text">{formatInt(player.knifeKills ?? 0)}</dd>
            <dd className="type-caption mt-1 text-text-2">
              {formatInt(player.knifeKills ?? 0)} bajas / {formatInt(player.knifeDeaths ?? 0)} muertes
            </dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Daño infligido</dt>
            <dd className="type-number-l stat-value mt-2 text-text">{formatInt(player.damageDealt ?? 0)}</dd>
            <dd className="type-caption mt-1 text-text-2">
              {player.damagePerKill !== null && player.damagePerKill !== undefined
                ? `por baja: ${formatDecimal(player.damagePerKill)}`
                : "sin bajas aún"}
            </dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">K/D</dt>
            <dd className={`type-number-l stat-value mt-2 ${player.kd >= 1.2 ? "text-accent" : player.kd >= 1 ? "text-text" : player.kd >= 0.8 ? "text-warning" : "text-danger"}`}>
              {new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(player.kd)}
            </dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">
              ELO
              <Info
                size={12}
                strokeWidth={1.75}
                aria-hidden="true"
                className="ml-1 inline shrink-0 align-baseline text-text-2"
              />
              <span className="sr-only" title="ELO interno: pondera la fuerza del rival, headshots, daño y penalidades por mata-equipo.">
                ELO interno: pondera la fuerza del rival, headshots, daño y penalidades por
                mata-equipo.
              </span>
            </dt>
            <dd
              title="ELO interno: pondera la fuerza del rival, headshots, daño y penalidades por mata-equipo."
              className={`type-number-l stat-value mt-2 ${player.skill === null || player.skill === undefined ? "text-text-2" : "text-text"}`}
            >
              {formatSkill(player.skill)}
            </dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Tiempo</dt>
            <dd className="type-number-l stat-value mt-2 text-text">{formatDuration(player.timePlayed)}</dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Últ. conexión</dt>
            <dd className="mt-2 text-[16px] font-medium leading-tight text-text">
              {online ? (
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                  En línea
                </span>
              ) : (
                formatRelative(player.lastConnection)
              )}
            </dd>
          </div>
        </dl>
        <p className="border-t border-border bg-surface px-4 pb-3 pt-2">
          <span className="type-caption text-text-2">
            ELO interno: pondera la fuerza del rival, headshots, daño y penalidades por
            mata-equipo.
          </span>
        </p>
      </div>

      {/* MI NUBE: solo el perfil de la cuenta logueada (cloud-save propio) */}
      {isOwnProfile && <CloudSavePanel />}

      {/* Actividad reciente (adaptación del supuesto D: la API expone eventos kill/death, no partidas) */}
      <section className="mt-8">
        <h2 className="type-display-l mb-4 text-text">Actividad reciente</h2>
        <ActivityTable detail={detail} weaponNames={weaponNames} />
      </section>
    </div>
  );
}
