import {
  Check,
  CircleAlert,
  FastForward,
  RefreshCcw,
  Repeat,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../lib/api";
import type { BotsOverview, MapCatalogEntry, PlaySessionInfo, ServerMapsResponse } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { Panel } from "../../components/ui/Panel";
import { Skeleton } from "../../components/ui/Spinner";
import { formatExpiresIn, formatInt, formatRelative } from "../../lib/format";
import type { ReactNode } from "react";

const MAPS_POLL_MS = 30_000;
const BOTS_POLL_MS = 30_000;
const SESSIONS_POLL_MS = 30_000;
const MAX_BOTS = 64;

/** El server no respondió por rcon (502 MODERATION_UNREACHABLE): mismo texto que la moderación. */
const SERVER_DOWN_TEXT =
  "El server no respondió por RCON — puede estar caído o reiniciando. Vuelve a intentarlo en unos segundos.";
const RCON_NOT_CONFIGURED_TEXT =
  "El control por RCON no está configurado en la API del ranking (falta RCON_PASSWORD).";

/** Mensaje humano para errores rcon (502/503) o genéricos. */
function rconErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 502) return SERVER_DOWN_TEXT;
    if (error.status === 503) return RCON_NOT_CONFIGURED_TEXT;
    return error.message;
  }
  return "No hay conexión con el servidor.";
}

function Banner({ tone, children }: { tone: "success" | "warning"; children: ReactNode }) {
  const toneClass =
    tone === "success"
      ? "border-accent-border bg-accent-subtle text-accent"
      : "border-warning/30 bg-warning/10 text-warning";
  return (
    <div
      role={tone === "warning" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm ${toneClass}`}
    >
      {tone === "success" ? (
        <Check size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
      ) : (
        <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function ForbiddenState() {
  return (
    <div className="rounded-md border border-border bg-surface">
      <EmptyState
        icon={ShieldAlert}
        title="Necesitas permisos de administrador."
        description="Esta sección solo está disponible para cuentas con rol ADMIN de la comunidad."
      />
    </div>
  );
}

/** Banner de server caído / sin RCON con reintentar (patrón de la moderación). */
function UnreachableState({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-4"
    >
      <WifiOff size={20} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <h3 className="type-display-m text-warning">Server sin conexión</h3>
        <p className="type-body mt-1 max-w-[68ch] text-text-2">{text}</p>
        <Button variant="ghost" size="sm" className="mt-3" onClick={onRetry}>
          <RefreshCcw size={14} strokeWidth={1.75} aria-hidden="true" />
          Reintentar
        </Button>
      </div>
    </div>
  );
}

/* ── Mapa ──────────────────────────────────────────────────────────────────── */

function MapCard({
  map,
  isCurrent,
  pending,
  busy,
  disabled,
  onAsk,
  onConfirm,
  onCancel,
}: {
  map: MapCatalogEntry;
  isCurrent: boolean;
  pending: boolean;
  busy: boolean;
  disabled: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (isCurrent) {
    return (
      <li className="flex items-center justify-between gap-2 rounded-sm border border-accent-border bg-accent-subtle p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text">{map.name}</p>
          <p className="type-mono truncate text-text-2">{map.id}</p>
        </div>
        <Badge variant="success">Actual</Badge>
      </li>
    );
  }

  return (
    <li
      className={`rounded-sm border border-border bg-surface p-3 transition-colors duration-150 ease-out ${
        pending ? "border-border-strong bg-surface-2" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text">{map.name}</p>
          <p className="type-mono truncate text-text-2">{map.id}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onAsk} disabled={disabled}>
          Cambiar
        </Button>
      </div>
      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3" aria-live="polite">
          <p className="type-caption min-w-0 flex-1 text-text-2">
            ¿Cambiar el server a <span className="font-semibold text-text">{map.name}</span>? La partida
            actual termina.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" loading={busy} onClick={onConfirm}>
              {busy ? "Cambiando…" : "Confirmar"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function MapsPanel() {
  const [data, setData] = useState<ServerMapsResponse | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "unreachable" | "forbidden" | "error">("loading");
  const [unreachableText, setUnreachableText] = useState<string>(SERVER_DOWN_TEXT);
  const [pollError, setPollError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [pendingMap, setPendingMap] = useState<string | null>(null);
  const [busyMap, setBusyMap] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [busyCommand, setBusyCommand] = useState<"rotate" | "fast_restart" | null>(null);

  // Refresco extra tras un comando: el server tarda unos segundos en aplicar el cambio.
  const refreshTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const refreshSoon = useCallback(() => {
    for (const timer of refreshTimers.current) clearTimeout(timer);
    refreshTimers.current = [5_000, 20_000, 40_000].map((delay) =>
      setTimeout(() => void loadSilent(), delay),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSilent = useCallback(async () => {
    try {
      const response = await api.serverMaps();
      setData(response);
      setPhase("ready");
      setPollError(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setPhase("forbidden");
        return;
      }
      // Sondeo en segundo plano: si ya hay datos, se quedan en pantalla con un aviso.
      if (data !== null) {
        setPollError(rconErrorText(error));
      } else {
        setUnreachableText(rconErrorText(error));
        setPhase("unreachable");
      }
    }
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await api.serverMaps();
        if (!cancelled) {
          setData(response);
          setPhase("ready");
          setPollError(null);
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 403) {
          setPhase("forbidden");
        } else if (error instanceof ApiError && (error.status === 502 || error.status === 503)) {
          setUnreachableText(rconErrorText(error));
          setPhase("unreachable");
        } else if (data !== null) {
          setPollError(rconErrorText(error));
        } else {
          setUnreachableText(rconErrorText(error));
          setPhase("unreachable");
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), MAPS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  useEffect(() => {
    const timers = refreshTimers.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  const handleChangeMap = async (mapId: string) => {
    setBusyMap(mapId);
    setNotice(null);
    try {
      const result = await api.changeMap(mapId);
      setNotice({ ok: true, text: result.note });
      setPendingMap(null);
      refreshSoon();
    } catch (error) {
      setNotice({ ok: false, text: rconErrorText(error) });
    } finally {
      setBusyMap(null);
    }
  };

  const handleCommand = async (command: "rotate" | "fast_restart") => {
    setBusyCommand(command);
    setNotice(null);
    try {
      const result =
        command === "rotate" ? await api.rotateMap() : await api.fastRestart();
      setNotice({ ok: true, text: result.note });
      setRotateOpen(false);
      setRestartOpen(false);
      refreshSoon();
    } catch (error) {
      setNotice({ ok: false, text: rconErrorText(error) });
      setRotateOpen(false);
      setRestartOpen(false);
    } finally {
      setBusyCommand(null);
    }
  };

  if (phase === "loading") {
    return (
      <div className="rounded-md border border-border bg-surface p-5">
        <Skeleton className="h-4 w-40" />
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-14" style={{ width: index % 2 === 0 ? "92%" : "86%" }} />
          ))}
        </div>
      </div>
    );
  }

  if (phase === "forbidden") return <ForbiddenState />;

  if (phase === "unreachable") {
    return <UnreachableState text={unreachableText} onRetry={() => setReloadKey((key) => key + 1)} />;
  }

  if (phase === "error" || data === null) {
    return (
      <UnreachableState
        text="No se pudo cargar el estado del server."
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  const currentName = data.current ? (data.maps.find((map) => map.id === data.current)?.name ?? data.current) : null;
  const groups: Array<{ id: "base" | "dlc"; label: string }> = [
    { id: "base", label: "Base" },
    { id: "dlc", label: "DLC" },
  ];

  return (
    <Panel
      title="Mapa"
      caption="Catálogo MW2/IW4x. El mapa actual se lee del server en vivo y se actualiza solo cada 30 s."
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setRotateOpen(true)} disabled={busyCommand !== null}>
            <Repeat size={14} strokeWidth={1.75} aria-hidden="true" />
            Rotar mapa
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRestartOpen(true)} disabled={busyCommand !== null}>
            <FastForward size={14} strokeWidth={1.75} aria-hidden="true" />
            Fast restart
          </Button>
        </div>
      }
    >
      <div className="space-y-5" aria-live="polite">
        {pollError && <Banner tone="warning">{pollError}</Banner>}
        {notice && <Banner tone={notice.ok ? "success" : "warning"}>{notice.text}</Banner>}

        <p className="type-caption text-text-2">
          Mapa actual:{" "}
          {data.current ? (
            <>
              <span className="text-sm font-semibold text-text">{currentName}</span>{" "}
              <span className="type-mono">({data.current})</span>
            </>
          ) : (
            "el server no lo reporta ahora mismo."
          )}
        </p>

        {groups.map((group) => {
          const maps = data.maps.filter((map) => map.group === group.id);
          if (maps.length === 0) return null;
          return (
            <div key={group.id}>
              <p className="type-label mb-2 text-text-2">
                {group.label} <span className="text-text-2">({formatInt(maps.length)})</span>
              </p>
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {maps.map((map) => (
                  <MapCard
                    key={map.id}
                    map={map}
                    isCurrent={data.current === map.id}
                    pending={pendingMap === map.id}
                    busy={busyMap === map.id}
                    disabled={busyMap !== null}
                    onAsk={() => setPendingMap(map.id)}
                    onConfirm={() => void handleChangeMap(map.id)}
                    onCancel={() => setPendingMap(null)}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <ConfirmModal
        open={rotateOpen}
        title="¿Rotar mapa?"
        confirmLabel="Rotar"
        loading={busyCommand === "rotate"}
        onCancel={() => setRotateOpen(false)}
        onConfirm={() => void handleCommand("rotate")}
      >
        El server avanza al siguiente mapa de la rotación. La partida en curso termina ahora mismo.
      </ConfirmModal>

      <ConfirmModal
        open={restartOpen}
        title="¿Fast restart?"
        confirmLabel="Reiniciar"
        loading={busyCommand === "fast_restart"}
        onCancel={() => setRestartOpen(false)}
        onConfirm={() => void handleCommand("fast_restart")}
      >
        El mapa actual se reinicia en segundos (mismo mapa, sin rotar). La partida en curso se pierde.
      </ConfirmModal>
    </Panel>
  );
}

/* ── Bots ──────────────────────────────────────────────────────────────────── */

/** Leyenda del skill según el source de Bot Warfare (_bot.gsc). */
function skillLegend(value: number): string {
  switch (value) {
    case 0:
      return "0 — Aleatorio dentro del rango bots_skill_min/max.";
    case 8:
      return "8 — Custom por equipo: usa los contadores de abajo (difícil = skill 7, medio = skill 4, el resto = skill 1).";
    case 9:
      return "9 — Caótico: cada bot elige un skill aleatorio continuo.";
    default:
      return `${value} — Skill fijo (gradiente 1 fácil → 7 difícil). Se re-aplica a los bots ya conectados en ≤1,5 s.`;
  }
}

/** Modo del select desde difficulty.value: "7" → "7"; null/parse fail → "0 — Aleatorio". */
function skillModeFromValue(value: string | null): string {
  if (value === null || value.trim() === "") return "0";
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 9 ? String(parsed) : "0";
}

function BotsPanel() {
  const [data, setData] = useState<BotsOverview | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "unreachable" | "forbidden" | "error">("loading");
  const [unreachableText, setUnreachableText] = useState<string>(SERVER_DOWN_TEXT);
  const [pollError, setPollError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [countInput, setCountInput] = useState("");
  const [countError, setCountError] = useState<string | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const [skillMode, setSkillMode] = useState("0");
  /** Último valor sincronizado desde el GET (para no pisar una elección del usuario). */
  const skillSyncedRef = useRef("0");
  const [teamCounts, setTeamCounts] = useState({
    alliesHard: "0",
    alliesMed: "0",
    axisHard: "0",
    axisMed: "0",
  });
  const [teamError, setTeamError] = useState<string | null>(null);
  const [difficultyApplying, setDifficultyApplying] = useState(false);
  const [difficultyResult, setDifficultyResult] = useState<string | null>(null);
  const [difficultyError, setDifficultyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await api.serverBots();
        if (cancelled) return;
        setData(response);
        setPhase("ready");
        setPollError(null);
        setCountInput((previous) =>
          previous === "" || previous === String(data?.count ?? "") ? String(response.count) : previous,
        );
        // Inicializa el select con el dvar real (ej. value "7" → "7 — Difícil");
        // solo si el usuario no lo ha cambiado desde la última sincronización.
        const nextSkill = skillModeFromValue(response.difficulty.value);
        setSkillMode((previous) => (previous === skillSyncedRef.current ? nextSkill : previous));
        skillSyncedRef.current = nextSkill;
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 403) {
          setPhase("forbidden");
        } else if (data === null) {
          setUnreachableText(rconErrorText(error));
          setPhase("unreachable");
        } else {
          setPollError(rconErrorText(error));
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), BOTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const parseCount = (): number | null => {
    const parsed = Number(countInput);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_BOTS) return null;
    return parsed;
  };

  const handleApplyCount = async () => {
    const count = parseCount();
    if (count === null) return;
    setApplying(true);
    setApplyResult(null);
    try {
      const result = await api.setBotCount(count);
      setApplyResult(
        `Comando enviado: ${formatInt(result.before)} → ${formatInt(result.after)} bots conectados` +
          (result.spawned > 0 ? ` (${formatInt(result.spawned)} nuevos en camino).` : ".") +
          (result.kicked.length > 0 ? ` Se expulsaron ${formatInt(result.kicked.length)} bots.` : ""),
      );
      setApplyOpen(false);
    } catch (error) {
      setApplyResult(null);
      setCountError(rconErrorText(error));
      setApplyOpen(false);
    } finally {
      setApplying(false);
    }
  };

  const handleApplyDifficulty = async () => {
    setDifficultyApplying(true);
    setDifficultyError(null);
    setDifficultyResult(null);
    try {
      const body =
        skillMode === "8"
          ? {
              alliesHard: Number(teamCounts.alliesHard),
              alliesMed: Number(teamCounts.alliesMed),
              axisHard: Number(teamCounts.axisHard),
              axisMed: Number(teamCounts.axisMed),
            }
          : { level: Number(skillMode) };
      const result = await api.setBotDifficulty(body);
      setDifficultyResult(result.note);
      // Refresca el GET de bots para confirmar el valor del dvar tras aplicar.
      setReloadKey((key) => key + 1);
    } catch (error) {
      setDifficultyError(rconErrorText(error));
    } finally {
      setDifficultyApplying(false);
    }
  };

  if (phase === "loading") {
    return (
      <div className="rounded-md border border-border bg-surface p-5">
        <Skeleton className="h-4 w-40" />
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" style={{ width: "85%" }} />
        </div>
      </div>
    );
  }

  if (phase === "forbidden") return <ForbiddenState />;

  if (phase === "unreachable") {
    return <UnreachableState text={unreachableText} onRetry={() => setReloadKey((key) => key + 1)} />;
  }

  if (phase === "error" || data === null) {
    return (
      <UnreachableState
        text="No se pudo cargar el estado de los bots."
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  const pendingCount = parseCount();
  const teamValue = (value: string) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_BOTS ? parsed : null;
  };
  const teamReady =
    teamValue(teamCounts.alliesHard) !== null &&
    teamValue(teamCounts.alliesMed) !== null &&
    teamValue(teamCounts.axisHard) !== null &&
    teamValue(teamCounts.axisMed) !== null;

  const inputClass = (error?: string | null) =>
    `h-10 w-full rounded-sm border bg-surface-2 px-3 text-text tabular transition-colors duration-150 ease-out focus:border-accent focus:shadow-[0_0_0_1px_#8FD429] focus:outline-none ${
      error ? "border-danger" : "border-border"
    }`;

  return (
    <Panel
      title="Bots"
      caption="El conteo lee el server en vivo cada 30 s. Ajustar el conteo crea o expulsa bots reales."
    >
      <div className="space-y-5" aria-live="polite">
        {pollError && <Banner tone="warning">{pollError}</Banner>}

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="type-label text-text-2">Bots conectados ahora</p>
            <p className="type-number-l stat-value mt-1 text-text">{formatInt(data.count)}</p>
          </div>
          <div className="min-w-[180px] flex-1 sm:max-w-[240px]">
            <Input
              label="Ajustar número de bots"
              type="number"
              min={0}
              max={MAX_BOTS}
              step={1}
              value={countInput}
              error={countError ?? undefined}
              onChange={(event) => {
                setCountInput(event.target.value);
                setCountError(null);
                setApplyResult(null);
              }}
            />
          </div>
          <Button
            onClick={() => {
              const count = parseCount();
              if (count === null) {
                setCountError(`Elige un número entero entre 0 y ${MAX_BOTS}.`);
                return;
              }
              setCountError(null);
              setApplyOpen(true);
            }}
            disabled={countInput === "" || pendingCount === null || pendingCount === data.count}
          >
            Aplicar
          </Button>
        </div>
        {applyResult && <Banner tone="success">{applyResult}</Banner>}

        {data.difficulty.found ? (
          <div className="rounded-sm border border-border bg-surface-2 p-4">
            <p className="type-label text-text-2">Dificultad (dvar {data.difficulty.dvar})</p>
            <p className="type-caption mt-1 text-text-2">
              Valor actual: <span className="type-mono text-text">{data.difficulty.value ?? "—"}</span>
              {data.difficulty.default !== null && (
                <>
                  {" "}· default <span className="type-mono text-text">{data.difficulty.default}</span>
                </>
              )}
            </p>
            <div className="mt-3 grid items-end gap-3 md:grid-cols-[minmax(0,260px)_1fr]">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="bots-skill" className="type-label text-text-2">
                  Modo de dificultad
                </label>
                <select
                  id="bots-skill"
                  value={skillMode}
                  onChange={(event) => {
                    setSkillMode(event.target.value);
                    setDifficultyResult(null);
                    setDifficultyError(null);
                  }}
                  className={inputClass()}
                >
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((value) => (
                    <option key={value} value={value}>
                      {value} — {
                        value === 0
                          ? "Aleatorio"
                          : value === 8
                            ? "Custom por equipo"
                            : value === 9
                              ? "Caótico"
                              : value === 1
                                ? "Fácil"
                                : value === 7
                                  ? "Difícil"
                                  : `Skill ${value}`
                      }
                    </option>
                  ))}
                </select>
                <p className="type-caption text-text-2">{skillLegend(Number(skillMode))}</p>
              </div>
              {skillMode === "8" && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {(
                    [
                      ["alliesHard", "Aliados difíciles"],
                      ["alliesMed", "Aliados medios"],
                      ["axisHard", "Axis difíciles"],
                      ["axisMed", "Axis medios"],
                    ] as Array<[keyof typeof teamCounts, string]>
                  ).map(([key, label]) => (
                    <Input
                      key={key}
                      label={label}
                      type="number"
                      min={0}
                      max={MAX_BOTS}
                      value={teamCounts[key]}
                      onChange={(event) => {
                        setTeamCounts((previous) => ({ ...previous, [key]: event.target.value }));
                        setTeamError(null);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="ghost"
                loading={difficultyApplying}
                disabled={skillMode === "8" && !teamReady}
                onClick={() => void handleApplyDifficulty()}
              >
                Aplicar dificultad
              </Button>
              {teamError && (
                <p role="alert" className="type-caption text-danger-hover">
                  {teamError}
                </p>
              )}
            </div>
            {difficultyResult && (
              <div className="mt-3">
                <Banner tone="success">{difficultyResult}</Banner>
              </div>
            )}
            {difficultyError && (
              <div className="mt-3">
                <Banner tone="warning">{difficultyError}</Banner>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-sm border border-border bg-surface-2 p-4">
            <p className="text-sm font-semibold text-text">
              Tu server no tiene el mod Bot Warfare instalado — la dificultad no está disponible.
            </p>
            <p className="type-caption mt-1 max-w-[68ch] text-text-2">
              El conteo de bots funciona. Instala iw4_bot_warfare en el server para habilitar la dvar{" "}
              <span className="type-mono">{data.difficulty.dvar}</span> y controlar la dificultad.
            </p>
            <p className="type-caption mt-2 max-w-[68ch] text-text-2">{data.difficulty.note}</p>
          </div>
        )}
      </div>

      <ConfirmModal
        open={applyOpen}
        title={`¿Ajustar los bots a ${formatInt(pendingCount ?? 0)}?`}
        confirmLabel="Aplicar"
        loading={applying}
        onCancel={() => setApplyOpen(false)}
        onConfirm={() => void handleApplyCount()}
      >
        Esto hace cambios REALES en el server ahora mismo: expulsa o crea bots (los nuevos tardan
        ~1 bot cada 500 ms en conectar) y afecta a la partida en curso.
      </ConfirmModal>
    </Panel>
  );
}

/* ── Exigir launcher + sesiones activas ────────────────────────────────────── */

function LauncherPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [toggleTarget, setToggleTarget] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [sessions, setSessions] = useState<PlaySessionInfo[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await api.launcherOnly();
        if (!cancelled) {
          setEnabled(response.enabled);
          setPhase("ready");
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 403) setPhase("forbidden");
        else setPhase("error");
      }
      try {
        const response = await api.serverSessions();
        if (!cancelled) {
          setSessions(response.sessions);
          setSessionsError(null);
          setNow(Date.now());
        }
      } catch (error) {
        if (!cancelled) setSessionsError(rconErrorText(error));
      }
    };
    void load();
    const timer = setInterval(() => void load(), SESSIONS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reloadKey]);

  const handleToggle = async () => {
    if (toggleTarget === null) return;
    setToggling(true);
    setNotice(null);
    try {
      const response = await api.setLauncherOnly(toggleTarget);
      setEnabled(response.enabled);
      setNotice({
        ok: true,
        text: response.enabled
          ? "Exigencia de launcher ACTIVADA: solo entran jugadores con sesión de launcher activa."
          : "Exigencia de launcher desactivada: todos pueden entrar al server.",
      });
      setToggleTarget(null);
    } catch (error) {
      setNotice({ ok: false, text: rconErrorText(error) });
      setToggleTarget(null);
    } finally {
      setToggling(false);
    }
  };

  if (phase === "loading") {
    return (
      <div className="rounded-md border border-border bg-surface p-5">
        <Skeleton className="h-4 w-56" />
        <div className="mt-4 space-y-2">
          <Skeleton className="h-10" style={{ width: "70%" }} />
          <Skeleton className="h-10" style={{ width: "45%" }} />
        </div>
      </div>
    );
  }

  if (phase === "forbidden") return <ForbiddenState />;

  if (phase === "error" || enabled === null) {
    return (
      <div className="rounded-md border border-border bg-surface">
        <EmptyState
          icon={WifiOff}
          title="No pudimos cargar el estado del launcher."
          description="Comprueba tu conexión e inténtalo de nuevo."
          action={
            <Button variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
              <RefreshCcw size={16} strokeWidth={1.75} aria-hidden="true" />
              Reintentar
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <Panel
      title="Exigir launcher"
      caption="Anti no-launcher: solo cuentas con sesión activa del launcher pueden jugar. Sesiones: refresco cada 30 s."
    >
      <div className="space-y-5" aria-live="polite">
        {notice && <Banner tone={notice.ok ? "success" : "warning"}>{notice.text}</Banner>}

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p id="launcher-only-label" className="text-sm font-semibold text-text">
              Exigir launcher para entrar al server
            </p>
            <p className="type-caption mt-0.5 max-w-[68ch] text-text-2">
              Los jugadores sin sesión activa del launcher son expulsados del server.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Badge variant={enabled ? "success" : "neutral"}>{enabled ? "Activado" : "Desactivado"}</Badge>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-labelledby="launcher-only-label"
              disabled={toggling}
              onClick={() => setToggleTarget(!enabled)}
              className="group inline-flex h-10 items-center rounded-sm transition-opacity duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span
                aria-hidden="true"
                className={`flex h-6 w-11 items-center rounded-sm border px-0.5 transition-colors duration-150 ease-out group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-accent-hover ${
                  enabled ? "justify-end border-accent-border bg-accent-subtle" : "justify-start border-border bg-surface-2"
                }`}
              >
                <span
                  className={`h-4 w-4 rounded-sm transition-colors duration-150 ease-out ${
                    enabled ? "bg-accent" : "bg-border-strong"
                  }`}
                />
              </span>
              <span className="sr-only">{enabled ? "Desactivar" : "Activar"} exigencia de launcher</span>
            </button>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <p className="type-label mb-2 text-text-2">
            Sesiones activas{" "}
            {sessions !== null && (
              <span className="text-text-2">({formatInt(sessions.length)})</span>
            )}
          </p>
          {sessionsError !== null ? (
            <Banner tone="warning">{sessionsError}</Banner>
          ) : sessions === null ? (
            <p className="type-caption text-text-2">Cargando sesiones…</p>
          ) : sessions.length === 0 ? (
            <p className="type-caption text-text-2">Sin sesiones activas ahora mismo.</p>
          ) : (
            <div className="overflow-x-auto rounded-sm border border-border">
              <table className="w-full">
                <caption className="sr-only">Sesiones de juego activas del launcher</caption>
                <thead>
                  <tr className="bg-surface-2">
                    <th scope="col" className="px-3 py-2 text-left">
                      <span className="type-label text-text-2">Nick</span>
                    </th>
                    <th scope="col" className="px-3 py-2 text-left">
                      <span className="type-label text-text-2">GUID</span>
                    </th>
                    <th scope="col" className="hidden px-3 py-2 text-left sm:table-cell">
                      <span className="type-label text-text-2">Última vez</span>
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      <span className="type-label text-text-2">Expira</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr
                      key={session.userId}
                      className="h-[40px] border-t border-border transition-colors duration-150 ease-out hover:bg-surface-2"
                    >
                      <td className="px-3 py-2 text-sm font-semibold text-text">{session.nick}</td>
                      <td className="px-3 py-2">
                        {session.guid ? (
                          <span className="type-mono text-text-2">{session.guid}</span>
                        ) : (
                          <span className="type-caption text-text-2">—</span>
                        )}
                      </td>
                      <td className="hidden px-3 py-2 sm:table-cell">
                        <span className="type-caption text-text-2">{formatRelative(session.lastSeen)}</span>
                      </td>
                      <td data-numeric className="px-3 py-2 text-right">
                        <span className="type-number-m text-text">
                          {formatExpiresIn(session.expiresAt, now)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        open={toggleTarget === true}
        title="¿Exigir launcher para entrar?"
        confirmLabel="Activar"
        loading={toggling}
        onCancel={() => setToggleTarget(null)}
        onConfirm={() => void handleToggle()}
      >
        Al activar se expulsará a todos los conectados sin launcher. A partir de ahora, solo podrán
        entrar al server los jugadores con una sesión activa del launcher.
      </ConfirmModal>

      <ConfirmModal
        open={toggleTarget === false}
        title="¿Desactivar la exigencia de launcher?"
        confirmLabel="Desactivar"
        loading={toggling}
        onCancel={() => setToggleTarget(null)}
        onConfirm={() => void handleToggle()}
      >
        Los jugadores sin launcher podrán volver a entrar al server libremente.
      </ConfirmModal>
    </Panel>
  );
}

/* ── Sección ───────────────────────────────────────────────────────────────── */

/** Server control: mapa, bots y exigir launcher por RCON (tab Admin → Server config). */
export function ServerControlPanel() {
  return (
    <section aria-label="Server control" className="mt-12">
      <h2 className="type-display-l text-text">Server control</h2>
      <p className="type-caption mt-2 max-w-[68ch] text-text-2">
        Control en vivo del server dedicado por RCON. Los comandos se envían al instante; el server
        tarda unos segundos en aplicarlos.
      </p>
      <div className="mb-4 mt-4 border-b border-border" aria-hidden="true" />
      <div className="space-y-4">
        <MapsPanel />
        <BotsPanel />
        <LauncherPanel />
      </div>
    </section>
  );
}
