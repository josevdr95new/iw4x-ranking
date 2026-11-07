import { Inbox, Link2, Search, SearchX, User, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import type { LeaderboardOrder, LeaderboardPlayer, LeaderboardResponse, LeaderboardSort } from "../lib/api";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { KdBadge } from "../components/ui/Badge";
import { Skeleton } from "../components/ui/Spinner";
import { RankCell } from "../components/RankCell";
import { SortableHeader } from "../components/SortableHeader";
import { Pagination } from "../components/Pagination";
import {
  formatDuration,
  formatInt,
  formatRelative,
  formatSkill,
  isBotGuid,
  isOnline,
  kdTextClass,
} from "../lib/format";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

interface Preset {
  id: string;
  label: string;
  sort: LeaderboardSort;
}

const PRESETS: Preset[] = [
  { id: "todos", label: "Todos", sort: "kills" },
  { id: "kd", label: "K/D", sort: "kd" },
  { id: "tiempo", label: "Tiempo jugado", sort: "timePlayed" },
];

/** Bot del server: la API lo marca con `isBot`; fallback a la heurística oficial del rango 0xB07 (API.md). */
function isBotPlayer(player: LeaderboardPlayer): boolean {
  return player.isBot ?? isBotGuid(player.guid);
}

/** Badge discreto de bot: hairline + mono, no altera el estilo de las filas humanas. */
function BotTag() {
  return (
    <span
      title="Bot del servidor"
      className="type-mono inline-flex h-[18px] items-center rounded-none border border-border px-1.5 text-[10px] leading-none text-text-2"
    >
      BOT
    </span>
  );
}

function PlayerNameCell({ player }: { player: LeaderboardPlayer }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Link
        to={`/player/${player.guid}`}
        className="text-sm font-semibold text-text transition-colors duration-150 ease-out hover:text-accent"
      >
        {player.name}
      </Link>
      {player.linked && (
        <span
          title="Cuenta vinculada"
          className="inline-flex items-center text-accent"
        >
          <Link2 size={12} strokeWidth={1.75} aria-hidden="true" />
          <span className="sr-only">Cuenta vinculada</span>
        </span>
      )}
      {isBotPlayer(player) && <BotTag />}
    </span>
  );
}

function LastConnectionCell({ player }: { player: LeaderboardPlayer }) {
  const online = isOnline(player.lastConnection);
  if (online) {
    return (
      <span className="inline-flex items-center justify-end gap-1.5 text-sm font-medium text-text">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
        {formatRelative(player.lastConnection)}
      </span>
    );
  }
  return (
    <span className="text-sm text-text-2">{formatRelative(player.lastConnection)}</span>
  );
}

function LeaderboardSkeleton() {
  // Anchos variables por fila: NO todos iguales (§4).
  const widths = [85, 70, 90, 60, 75, 80];
  return (
    <div aria-hidden="true">
      {widths.map((width, index) => (
        <div
          key={index}
          className="flex h-[44px] items-center justify-between gap-4 border-b border-border px-3 last:border-b-0"
        >
          <div className="flex items-center gap-4">
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-3" style={{ width: `${width * 0.6}%`, maxWidth: "220px" }} />
          </div>
          <div className="flex items-center gap-8">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-14" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function LeaderboardPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("q") ?? "";
  const sort = (searchParams.get("sort") ?? "kills") as LeaderboardSort;
  const order = (searchParams.get("order") ?? "desc") as LeaderboardOrder;
  const pageParam = Number(searchParams.get("page") ?? "1");
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;
  /** "Solo humanos" por defecto; ?bots=1 muestra también los bots del server. */
  const showBots = searchParams.get("bots") === "1";

  const [queryInput, setQueryInput] = useState(search);
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);

  // Estado de sincronización público (API v0.2): para "Actualizado hace X".
  useEffect(() => {
    let cancelled = false;
    api
      .syncStatus()
      .then((response) => {
        if (!cancelled) setLastSyncAt(response.lastSyncAt);
      })
      .catch(() => {
        // Sin dato de sync se omite la línea; fallo silencioso.
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Sincroniza el input cuando cambia la URL (navegación atrás/adelante).
  useEffect(() => {
    setQueryInput(search);
  }, [search]);

  // Debounce de búsqueda: escribe el parámetro q tras 300 ms.
  useEffect(() => {
    const normalized = queryInput.trim();
    if (normalized === search) return;
    const timer = window.setTimeout(() => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (normalized) next.set("q", normalized);
          else next.delete("q");
          next.set("page", "1");
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [queryInput, search, setSearchParams]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    api
      .leaderboard({
        sort,
        order,
        search: search || undefined,
        page,
        pageSize: PAGE_SIZE,
        includeBots: showBots,
      })
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sort, order, search, page, showBots, reloadKey]);

  const updateParams = (changes: { sort?: LeaderboardSort; order?: LeaderboardOrder; page?: number }) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (changes.sort !== undefined) next.set("sort", changes.sort);
      if (changes.order !== undefined) next.set("order", changes.order);
      if (changes.page !== undefined) next.set("page", String(changes.page));
      else next.delete("page");
      return next;
    });
  };

  const handleToggleBots = (humansOnly: boolean) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (humansOnly) next.delete("bots");
        else next.set("bots", "1");
        next.set("page", "1");
        return next;
      },
      { replace: true },
    );
  };

  const handleSort = (field: LeaderboardSort) => {
    if (field === sort) {
      updateParams({ order: order === "desc" ? "asc" : "desc", page: 1 });
    } else {
      updateParams({ sort: field, order: "desc", page: 1 });
    }
  };

  const handlePreset = (preset: Preset) => {
    updateParams({ sort: preset.sort, order: "desc", page: 1 });
  };

  const handlePage = (next: number) => {
    updateParams({ page: next });
    window.scrollTo({ top: 0 });
  };

  const players = data?.players ?? [];

  const lastUpdateRelative = lastSyncAt ? formatRelative(lastSyncAt) : null;

  const activePreset = PRESETS.find((preset) => preset.sort === sort && order === "desc");
  const searchActive = search.trim().length > 0;

  const sortDescription = `Ranking de jugadores de la comunidad, ordenado por ${sort} en orden ${order === "desc" ? "descendente" : "ascendente"}`;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2 pb-4">
        <h1 className="type-display-xl text-text">Ranking de la comunidad</h1>
        <p className="type-label text-text-2" aria-live="polite">
          {data ? `${formatInt(data.total)} jugadores` : "\u00A0"}
        </p>
      </div>
      <p className="type-caption -mt-2 pb-4 uppercase text-text-2">
        {status === "ready" && lastUpdateRelative
          ? `Actualizado ${lastUpdateRelative}`
          : "\u00A0"}
      </p>
      <div className="border-b border-border" aria-hidden="true" />

      {/* Toolbar */}
      <div className="mb-4 mt-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="w-full md:w-[320px]">
          <Input
            label=""
            aria-label="Buscar jugador"
            icon={<Search size={16} strokeWidth={1.75} aria-hidden="true" />}
            placeholder="Buscar jugador…"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            type="search"
            autoComplete="off"
          />
        </div>
        <div className="flex items-center gap-3">
          <div role="group" aria-label="Orden preset del ranking" className="flex overflow-x-auto">
            {PRESETS.map((preset) => {
              const active = !searchActive && activePreset?.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handlePreset(preset)}
                  disabled={searchActive}
                  aria-pressed={active}
                  className={`type-button flex h-10 items-center whitespace-nowrap rounded-sm px-4 transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40 ${
                    active
                      ? "border border-accent-border bg-accent-subtle text-accent"
                      : "text-text-2 hover:text-text"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => handleToggleBots(showBots)}
            aria-pressed={!showBots}
            title={showBots ? "Mostrando también bots del server" : "Ocultando bots del server"}
            className={`type-button flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-3 transition-colors duration-150 ease-out ${
              !showBots
                ? "border border-accent-border bg-accent-subtle text-accent"
                : "text-text-2 hover:text-text"
            }`}
          >
            <User size={14} strokeWidth={1.75} aria-hidden="true" />
            Solo humanos
          </button>
        </div>
      </div>

      {/* Panel del ranking */}
      <div className="overflow-hidden rounded-md border border-border bg-surface">
        {status === "loading" && <LeaderboardSkeleton />}

        {status === "error" && (
          <EmptyState
            icon={WifiOff}
            title="No pudimos cargar el ranking."
            description="Comprueba tu conexión e inténtalo de nuevo."
            action={
              <Button onClick={() => setReloadKey((key) => key + 1)}>Reintentar</Button>
            }
          />
        )}

        {status === "ready" && data && data.total === 0 && (
          <>
            {searchActive ? (
              <EmptyState
                icon={SearchX}
                title={`Ningún jugador coincide con «${search}».`}
                description="Revisa la ortografía o prueba con menos caracteres."
              />
            ) : (
              <EmptyState
                icon={Inbox}
                title="Todavía no hay partidas registradas en los servidores de la comunidad."
                description="Entra a un servidor y tu nombre aparecerá aquí automáticamente."
              />
            )}
          </>
        )}

        {status === "ready" && data && data.total > 0 && (
          <>
            {/* Tabla md+ */}
            <table className="hidden w-full md:table">
              <caption className="sr-only">{sortDescription}</caption>
              <thead>
                <tr className="bg-surface">
                  <th scope="col" className="w-14 px-3 py-2.5 text-left">
                    <span className="type-label text-text-2">#</span>
                  </th>
                  <th scope="col" className="min-w-[180px] px-3 py-2.5 text-left">
                    <span className="type-label text-text-2">Jugador</span>
                  </th>
                  <th scope="col" className="w-[9%] px-3 py-2.5 text-right" aria-sort={sort === "kills" ? (order === "desc" ? "descending" : "ascending") : undefined}>
                    <SortableHeader label="Kills" field="kills" activeField={sort} activeOrder={order} onSort={handleSort} />
                  </th>
                  <th scope="col" className="w-[10%] px-3 py-2.5 text-right" aria-sort={sort === "deaths" ? (order === "desc" ? "descending" : "ascending") : undefined}>
                    <SortableHeader label="Muertes" field="deaths" activeField={sort} activeOrder={order} onSort={handleSort} />
                  </th>
                  <th scope="col" className="w-[8%] px-3 py-2.5 text-right" aria-sort={sort === "kd" ? (order === "desc" ? "descending" : "ascending") : undefined}>
                    <SortableHeader label="K/D" field="kd" activeField={sort} activeOrder={order} onSort={handleSort} />
                  </th>
                  <th scope="col" className="hidden w-[8%] px-3 py-2.5 text-right lg:table-cell" aria-sort={sort === "skill" ? (order === "desc" ? "descending" : "ascending") : undefined}>
                    <SortableHeader label="Skill" field="skill" activeField={sort} activeOrder={order} onSort={handleSort} />
                  </th>
                  <th scope="col" className="w-[10%] px-3 py-2.5 text-right" aria-sort={sort === "timePlayed" ? (order === "desc" ? "descending" : "ascending") : undefined}>
                    <SortableHeader label="Tiempo" field="timePlayed" activeField={sort} activeOrder={order} onSort={handleSort} />
                  </th>
                  <th scope="col" className="hidden w-[12%] px-3 py-2.5 text-right lg:table-cell">
                    <span className="type-label text-text-2">Últ. conexión</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {players.map((player) => (
                  <tr
                    key={player.guid}
                    onClick={() => navigate(`/player/${player.guid}`)}
                    className={`h-[44px] cursor-pointer border-b border-border transition-colors duration-150 ease-out last:border-b-0 hover:bg-surface-2 ${
                      player.rank === 1 ? "bg-accent-subtle" : ""
                    }`}
                  >
                    <td className="px-3 py-2.5">
                      <RankCell rank={player.rank} />
                    </td>
                    <td className="px-3 py-2.5">
                      <PlayerNameCell player={player} />
                    </td>
                    <td data-numeric className="px-3 py-2.5 text-right">
                      <span className="type-number-m text-text">{formatInt(player.kills)}</span>
                    </td>
                    <td data-numeric className="px-3 py-2.5 text-right">
                      <span className="type-number-m text-text">{formatInt(player.deaths)}</span>
                    </td>
                    <td data-numeric className="px-3 py-2.5 text-right">
                      <KdBadge value={player.kd} />
                    </td>
                    <td data-numeric className="hidden px-3 py-2.5 text-right lg:table-cell">
                      <span
                        className={`type-number-m ${player.skill === null || player.skill === undefined ? "text-text-2" : "text-text"}`}
                      >
                        {formatSkill(player.skill)}
                      </span>
                    </td>
                    <td data-numeric className="px-3 py-2.5 text-right">
                      <span className="type-number-m text-text">{formatDuration(player.timePlayed)}</span>
                    </td>
                    <td className="hidden px-3 py-2.5 text-right lg:table-cell">
                      <LastConnectionCell player={player} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Fila-cards <md: mismo ritmo de lista, no cards flotantes (§5) */}
            <ul className="md:hidden">
              {players.map((player) => (
                <li key={player.guid} className={`border-b border-border last:border-b-0 ${player.rank === 1 ? "bg-accent-subtle" : ""}`}>
                  <Link
                    to={`/player/${player.guid}`}
                    className="flex items-center gap-3 px-3 py-3 transition-colors duration-150 ease-out hover:bg-surface-2"
                  >
                    <div className="w-12 shrink-0">
                      <RankCell rank={player.rank} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="type-display-m flex items-center gap-1.5 truncate text-text">
                        {player.name}
                        {player.linked && (
                          <span title="Cuenta vinculada" className="inline-flex shrink-0 items-center text-accent">
                            <Link2 size={12} strokeWidth={1.75} aria-hidden="true" />
                            <span className="sr-only">Cuenta vinculada</span>
                          </span>
                        )}
                        {isBotPlayer(player) && <BotTag />}
                      </p>
                      <p className="type-caption mt-0.5 tabular text-text-2">
                        {formatInt(player.kills)} K · {formatInt(player.deaths)} M ·{" "}
                        {formatDuration(player.timePlayed)}
                        {player.skill !== null && player.skill !== undefined && (
                          <>
                            {" "}· Skill {formatSkill(player.skill)}
                          </>
                        )}
                      </p>
                    </div>
                    <span className={`type-number-m shrink-0 tabular ${kdTextClass(player.kd)}`}>
                      K/D {new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(player.kd)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <Pagination
              page={data.page}
              totalPages={data.totalPages}
              rangeStart={(data.page - 1) * data.pageSize + 1}
              rangeEnd={Math.min(data.page * data.pageSize, data.total)}
              total={data.total}
              onPageChange={handlePage}
            />
          </>
        )}
      </div>
    </div>
  );
}
