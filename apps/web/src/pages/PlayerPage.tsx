import { ArrowLeft, Inbox, RefreshCcw, ShieldAlert, UserX, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../lib/api";
import type { PlayerDetail } from "../lib/api";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Skeleton } from "../components/ui/Spinner";
import {
  formatDuration,
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
      <div className="grid grid-cols-3 gap-px border-t border-border bg-border md:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="bg-surface p-4">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="mt-3 h-6 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityTable({ detail }: { detail: PlayerDetail }) {
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
                  {isKill ? (
                    <Badge variant="success">Baja</Badge>
                  ) : (
                    <Badge variant="danger">Muerte</Badge>
                  )}
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
                <td className="px-3 py-2.5">
                  <span className="type-mono text-text-2">{event.weapon}</span>
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

export function PlayerPage() {
  const { guid = "" } = useParams<{ guid: string }>();
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "not-found" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);

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
            <p className="type-caption mt-1 text-text-2">
              Miembro desde {formatMemberSince(player.firstConnection)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-end md:gap-3">
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

        {/* Stat strip: celdas con hairlines, NO cards (§3.3) */}
        <dl className="grid grid-cols-3 gap-px border-t border-border bg-border md:grid-cols-6">
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Kills</dt>
            <dd className="type-number-l stat-value mt-2 text-text">{formatInt(player.kills)}</dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Muertes</dt>
            <dd className="type-number-l stat-value mt-2 text-text">{formatInt(player.deaths)}</dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">K/D</dt>
            <dd className={`type-number-l stat-value mt-2 ${player.kd >= 1.2 ? "text-accent" : player.kd >= 1 ? "text-text" : player.kd >= 0.8 ? "text-warning" : "text-danger"}`}>
              {new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(player.kd)}
            </dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="type-label text-text-2">Skill</dt>
            <dd className={`type-number-l stat-value mt-2 ${player.skill === null || player.skill === undefined ? "text-text-2" : "text-text"}`}>
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
      </div>

      {/* Actividad reciente (adaptación del supuesto D: la API expone eventos kill/death, no partidas) */}
      <section className="mt-8">
        <h2 className="type-display-l mb-4 text-text">Actividad reciente</h2>
        <ActivityTable detail={detail} />
      </section>
    </div>
  );
}
