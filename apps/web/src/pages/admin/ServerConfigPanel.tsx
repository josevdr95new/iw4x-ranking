import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  Plus,
  Power,
  ShieldAlert,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, api } from "../../lib/api";
import type {
  GameGametype,
  RotationEntry,
  ServerConfig,
  ServerConfigSaveRequest,
} from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Spinner";
import { formatInt } from "../../lib/format";

const GAMETYPE_PRESETS = ["war", "dom", "sab", "ctf", "koth"] as const;

/** Gametypes válidos según la validación del PUT (API.md §Admin). */
const GAMETYPE_ALL: GameGametype[] = [
  "war",
  "dm",
  "dom",
  "koth",
  "sab",
  "sd",
  "ctf",
  "oneflag",
  "gtnw",
  "arena",
  "dd",
  "vip",
];

const MAP_SUGGESTIONS = ["mp_rust", "mp_terminal", "mp_highrise", "mp_cross_fire", "mp_strike"];
const MAP_PATTERN = /^[a-z0-9_]{2,32}$/;

interface FieldErrors {
  [field: string]: string;
}

const inputClass = (error?: string) =>
  `h-10 w-full rounded-sm border bg-surface-2 px-3 text-text transition-colors duration-150 ease-out focus:border-accent focus:shadow-[0_0_0_1px_#8FD429] focus:outline-none ${
    error ? "border-danger" : "border-border"
  }`;

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="type-label text-text-2">
        {label}
      </label>
      {children}
      {hint && !error && <p className="type-caption text-text-2">{hint}</p>}
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-[13px] text-danger-hover">
          <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-5 py-3">
        <h2 className="type-display-m text-text">{title}</h2>
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "success" | "warning";
  children: ReactNode;
}) {
  const toneClass =
    tone === "success"
      ? "border-accent-border bg-accent-subtle text-accent"
      : "border-warning/30 bg-warning/10 text-warning";
  return (
    <div
      role={tone === "warning" ? "status" : undefined}
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

export function ServerConfigPanel() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);

  // Formulario
  const [hostname, setHostname] = useState("");
  const [motd, setMotd] = useState("");
  const [gametypeMode, setGametypeMode] = useState<"preset" | "custom">("preset");
  const [gametypePreset, setGametypePreset] = useState<string>("war");
  const [gametypeCustom, setGametypeCustom] = useState("");
  const [maxclients, setMaxclients] = useState("12");
  const [bots, setBots] = useState("0");
  const [logfile, setLogfile] = useState("2");
  const [g_log, setGLog] = useState("");
  const [rconInput, setRconInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [rotation, setRotation] = useState<RotationEntry[]>([]);
  const [rotationError, setRotationError] = useState<string | null>(null);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    backupPath: string;
    restarted: boolean;
    warnings: string[];
  } | null>(null);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartNotice, setRestartNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    api
      .getServerConfig()
      .then((response) => {
        if (cancelled) return;
        const cfg = response.config;
        setConfig(cfg);
        setHostname(cfg.hostname);
        setMotd(cfg.motd);
        if (GAMETYPE_PRESETS.includes(cfg.gametype as (typeof GAMETYPE_PRESETS)[number])) {
          setGametypeMode("preset");
          setGametypePreset(cfg.gametype);
        } else {
          setGametypeMode("custom");
          setGametypeCustom(cfg.gametype);
        }
        setMaxclients(String(cfg.maxclients));
        setBots(String(cfg.bots));
        setLogfile(String(cfg.logfile));
        setGLog(cfg.g_log);
        setRotation(cfg.rotation.map((entry) => ({ ...entry })));
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 403) setStatus("forbidden");
        else setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const currentGametype = gametypeMode === "preset" ? gametypePreset : gametypeCustom.trim();

  const dirty = useMemo(() => {
    if (!config) return false;
    return (
      hostname !== config.hostname ||
      motd !== config.motd ||
      currentGametype !== config.gametype ||
      maxclients !== String(config.maxclients) ||
      bots !== String(config.bots) ||
      logfile !== String(config.logfile) ||
      g_log !== config.g_log ||
      rconInput.length > 0 ||
      passwordInput.length > 0 ||
      JSON.stringify(rotation) !== JSON.stringify(config.rotation)
    );
  }, [config, hostname, motd, currentGametype, maxclients, bots, logfile, g_log, rconInput, passwordInput, rotation]);

  const moveRotation = (index: number, delta: -1 | 1) => {
    setRotation((rows) => {
      const next = [...rows];
      const target = index + delta;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const validateRotation = (): string | null => {
    if (rotation.length < 1) return "La rotación necesita al menos un mapa.";
    if (rotation.length > 32) return "La rotación admite 32 mapas como máximo.";
    for (let i = 0; i < rotation.length; i += 1) {
      const entry = rotation[i];
      if (!MAP_PATTERN.test(entry.map.trim())) {
        return `Mapa ${i + 1}: usa 2–32 caracteres (minúsculas, números y _).`;
      }
      if (!entry.gametype) {
        return `Mapa ${i + 1}: elige un gametype.`;
      }
    }
    return null;
  };

  const handleSave = async () => {
    if (!config) return;
    setSaveResult(null);
    setFieldErrors({});
    setRotationError(null);

    const clientRotationError = validateRotation();
    if (clientRotationError) {
      setRotationError(clientRotationError);
      return;
    }

    const body: ServerConfigSaveRequest = {};
    if (hostname !== config.hostname) body.hostname = hostname;
    if (motd !== config.motd) body.motd = motd;
    if (currentGametype !== config.gametype) body.gametype = currentGametype;
    if (maxclients !== String(config.maxclients)) body.maxclients = Number(maxclients);
    if (bots !== String(config.bots)) body.bots = Number(bots);
    if (logfile !== String(config.logfile)) body.logfile = Number(logfile);
    if (g_log !== config.g_log) body.g_log = g_log;
    if (rconInput.length > 0) body.rcon = rconInput;
    if (passwordInput.length > 0) body.password = passwordInput;
    if (JSON.stringify(rotation) !== JSON.stringify(config.rotation)) {
      body.rotation = rotation.map((entry) => ({
        map: entry.map.trim(),
        gametype: entry.gametype,
      }));
    }

    if (Object.keys(body).length === 0) return;

    setSaving(true);
    try {
      const response = await api.putServerConfig(body);
      setSaveResult({
        backupPath: response.backupPath,
        restarted: response.restarted,
        warnings: response.warnings ?? [],
      });
      // El disco quedó igual al formulario: nueva línea base.
      setConfig((previous) =>
        previous
          ? {
              ...previous,
              ...(body.hostname !== undefined ? { hostname: body.hostname } : {}),
              ...(body.motd !== undefined ? { motd: body.motd } : {}),
              ...(body.gametype !== undefined ? { gametype: body.gametype } : {}),
              ...(body.maxclients !== undefined ? { maxclients: body.maxclients } : {}),
              ...(body.bots !== undefined ? { bots: body.bots } : {}),
              ...(body.logfile !== undefined ? { logfile: body.logfile } : {}),
              ...(body.g_log !== undefined ? { g_log: body.g_log } : {}),
              ...(body.rotation !== undefined ? { rotation: body.rotation } : {}),
            }
          : previous,
      );
      setRconInput("");
      setPasswordInput("");
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (error instanceof ApiError) {
        const errors: FieldErrors = {};
        for (const issue of error.details?.issues ?? []) {
          const rawPath = Array.isArray(issue.path) ? issue.path.join(".") : String(issue.path ?? "");
          const field = rawPath.split(".")[0] ?? "";
          if (field && !(field in errors)) errors[field] = issue.message;
        }
        if (errors.rotation) setRotationError(errors.rotation);
        else setFieldErrors(errors);
        if (Object.keys(errors).length === 0 && !errors.rotation) {
          setFieldErrors({ form: "No se pudo guardar la configuración. Inténtalo de nuevo." });
        }
      } else {
        setFieldErrors({ form: "No se pudo guardar la configuración. Inténtalo de nuevo." });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    setRestartNotice(null);
    try {
      const response = await api.restartServer();
      setRestartNotice({
        ok: true,
        text: "Server reiniciado. La nueva configuración ya está en uso.",
      });
      setShowRestartModal(false);
      void response;
    } catch (error) {
      setShowRestartModal(false);
      if (error instanceof ApiError && error.status === 403) {
        setRestartNotice({
          ok: false,
          text: "El reinicio está deshabilitado en este server (flag ALLOW_SERVER_CONTROL no activado o sin comando configurado). Guardar la configuración sigue funcionando con normalidad.",
        });
      } else {
        setRestartNotice({
          ok: false,
          text: "No se pudo reiniciar el server. Inténtalo de nuevo en unos segundos.",
        });
      }
    } finally {
      setRestarting(false);
    }
  };

  if (status === "loading") {
    return (
      <div aria-hidden="true" className="space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-96" />
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="rounded-md border border-border bg-surface p-5">
            <Skeleton className="h-4 w-32" />
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" style={{ width: "85%" }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (status === "forbidden") {
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

  if (status === "error" || !config) {
    return (
      <div className="rounded-md border border-border bg-surface">
        <EmptyState
          icon={WifiOff}
          title="No pudimos cargar la configuración."
          description="Comprueba tu conexión e inténtalo de nuevo."
          action={<Button onClick={() => setReloadKey((key) => key + 1)}>Reintentar</Button>}
        />
      </div>
    );
  }

  return (
    <div>
      <h1 className="type-display-xl text-text">Configuración del servidor</h1>
      <p className="type-caption mt-2 text-text-2">
        {config.metadata.path} · última modificación{" "}
        {new Date(config.metadata.lastModified).toLocaleString("es-ES", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}{" "}
        · {formatInt(config.metadata.sizeBytes)} bytes
      </p>
      <div className="mb-6 mt-4 border-b border-border" aria-hidden="true" />

      <div className="space-y-4" aria-live="polite">
        {saveResult && (
          <Banner tone="success">
            <p className="font-medium">Config guardada.</p>
            <p className="type-caption mt-0.5 break-all text-text-2">
              Backup: {saveResult.backupPath}
            </p>
            {!saveResult.restarted && saveResult.warnings.length > 0 && (
              <div className="mt-2 rounded-sm border border-warning/30 bg-warning/10 px-3 py-2 text-warning">
                {saveResult.warnings.map((warning) => (
                  <p key={warning} className="type-caption">
                    Aviso informativo: {warning} La config quedó guardada; el server se reiniciará
                    más tarde o manualmente.
                  </p>
                ))}
              </div>
            )}
          </Banner>
        )}
        {restartNotice && (
          <Banner tone={restartNotice.ok ? "success" : "warning"}>{restartNotice.text}</Banner>
        )}
      </div>

      <div className="mt-6 space-y-4">
        <Panel title="General">
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Hostname"
              htmlFor="cfg-hostname"
              error={fieldErrors.hostname}
              hint="Máximo 64 caracteres, sin comillas."
            >
              <input
                id="cfg-hostname"
                type="text"
                value={hostname}
                maxLength={64}
                onChange={(event) => setHostname(event.target.value)}
                className={inputClass(fieldErrors.hostname)}
              />
            </Field>
            <Field
              label="Max clients"
              htmlFor="cfg-maxclients"
              error={fieldErrors.maxclients}
              hint="1–64 jugadores."
            >
              <input
                id="cfg-maxclients"
                type="number"
                min={1}
                max={64}
                value={maxclients}
                onChange={(event) => setMaxclients(event.target.value)}
                className={`${inputClass(fieldErrors.maxclients)} tabular`}
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="Motd" htmlFor="cfg-motd" error={fieldErrors.motd}>
                <textarea
                  id="cfg-motd"
                  value={motd}
                  rows={3}
                  onChange={(event) => setMotd(event.target.value)}
                  className={`min-h-[80px] w-full rounded-sm border bg-surface-2 px-3 py-2 text-text transition-colors duration-150 ease-out focus:border-accent focus:shadow-[0_0_0_1px_#8FD429] focus:outline-none ${
                    fieldErrors.motd ? "border-danger" : "border-border"
                  }`}
                />
              </Field>
            </div>
          </div>
        </Panel>

        <Panel title="Juego">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Gametype por defecto" htmlFor="cfg-gametype" error={fieldErrors.gametype}>
              <div className="flex gap-2">
                <select
                  id="cfg-gametype"
                  value={gametypeMode === "preset" ? gametypePreset : "__custom"}
                  onChange={(event) => {
                    if (event.target.value === "__custom") {
                      setGametypeMode("custom");
                      setGametypeCustom("");
                    } else {
                      setGametypeMode("preset");
                      setGametypePreset(event.target.value);
                    }
                  }}
                  className={inputClass(fieldErrors.gametype)}
                >
                  {GAMETYPE_PRESETS.map((gt) => (
                    <option key={gt} value={gt}>
                      {gt.toUpperCase()}
                    </option>
                  ))}
                  <option value="__custom">OTRO…</option>
                </select>
                {gametypeMode === "custom" && (
                  <input
                    type="text"
                    value={gametypeCustom}
                    placeholder="Gametype"
                    onChange={(event) => setGametypeCustom(event.target.value)}
                    aria-label="Gametype personalizado"
                    className={inputClass(fieldErrors.gametype)}
                  />
                )}
              </div>
            </Field>
            <Field
              label="Bots (scr_testclients)"
              htmlFor="cfg-bots"
              error={fieldErrors.bots}
              hint="0–24 y nunca más que max clients."
            >
              <input
                id="cfg-bots"
                type="number"
                min={0}
                max={24}
                value={bots}
                onChange={(event) => setBots(event.target.value)}
                className={`${inputClass(fieldErrors.bots)} tabular`}
              />
            </Field>
          </div>
        </Panel>

        <Panel title="Rotación de mapas">
          {rotationError && (
            <p role="alert" className="mb-3 flex items-start gap-1.5 text-[13px] text-danger-hover">
              <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
              {rotationError}
            </p>
          )}
          <ul className="divide-y divide-border">
            {rotation.map((entry, index) => (
              <li
                key={`${entry.map}-${index}`}
                className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0"
              >
                <span
                  aria-hidden="true"
                  className="type-caption w-6 shrink-0 text-right tabular text-text-2"
                >
                  {formatInt(index + 1)}
                </span>
                <input
                  type="text"
                  list="map-suggestions"
                  value={entry.map}
                  onChange={(event) =>
                    setRotation((rows) =>
                      rows.map((row, i) =>
                        i === index ? { ...row, map: event.target.value.toLowerCase() } : row,
                      ),
                    )
                  }
                  aria-label={`Mapa ${index + 1}`}
                  className={`${inputClass()} min-w-0 flex-1 tabular`}
                />
                <select
                  value={entry.gametype}
                  onChange={(event) =>
                    setRotation((rows) =>
                      rows.map((row, i) =>
                        i === index ? { ...row, gametype: event.target.value } : row,
                      ),
                    )
                  }
                  aria-label={`Gametype del mapa ${index + 1}`}
                  className={`${inputClass()} w-24 shrink-0`}
                >
                  {GAMETYPE_ALL.map((gt) => (
                    <option key={gt} value={gt}>
                      {gt.toUpperCase()}
                    </option>
                  ))}
                </select>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveRotation(index, -1)}
                    disabled={index === 0}
                    aria-label={`Subir mapa ${index + 1}`}
                    className="flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveRotation(index, 1)}
                    disabled={index === rotation.length - 1}
                    aria-label={`Bajar mapa ${index + 1}`}
                    className="flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowDown size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRotation((rows) => rows.filter((_, i) => i !== index))}
                    disabled={rotation.length <= 1}
                    aria-label={`Quitar mapa ${index + 1}`}
                    className="flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-danger-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <datalist id="map-suggestions">
            {MAP_SUGGESTIONS.map((map) => (
              <option key={map} value={map} />
            ))}
          </datalist>
          <div className="mt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setRotation((rows) => [...rows, { map: "", gametype: "war" as GameGametype }])
              }
              disabled={rotation.length >= 32}
            >
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
              Añadir mapa
            </Button>
          </div>
        </Panel>

        <Panel title="Logging">
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Logfile"
              htmlFor="cfg-logfile"
              error={fieldErrors.logfile}
              hint="2 = completo, 1 = parcial, 0 = apagado."
            >
              <select
                id="cfg-logfile"
                value={logfile}
                onChange={(event) => setLogfile(event.target.value)}
                className={inputClass(fieldErrors.logfile)}
              >
                <option value="2">2 — Completo</option>
                <option value="1">1 — Parcial</option>
                <option value="0">0 — Apagado</option>
              </select>
            </Field>
            <Field
              label="G_log"
              htmlFor="cfg-glog"
              error={fieldErrors.g_log}
              hint="Necesario para el ranking: aquí escribe el log que leemos."
            >
              <input
                id="cfg-glog"
                type="text"
                value={g_log}
                onChange={(event) => setGLog(event.target.value)}
                className={`${inputClass(fieldErrors.g_log)} type-mono`}
              />
            </Field>
          </div>
        </Panel>

        <Panel title="Seguridad">
          <p className="type-caption mb-4 max-w-[68ch] text-text-2">
            Por seguridad, los valores actuales se muestran enmascarados. Lo que escribas en los
            campos reemplaza el valor guardado; déjalos vacíos para no cambiar nada.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-sm border border-border bg-surface-2 px-3 py-2">
              <p className="type-caption text-text-2">RCON actual</p>
              <p className="type-mono mt-0.5 text-text">
                {config.rconSet ? (config.rcon ?? "") : "Sin valor"}
              </p>
            </div>
            <div className="rounded-sm border border-border bg-surface-2 px-3 py-2">
              <p className="type-caption text-text-2">Password actual</p>
              <p className="type-mono mt-0.5 text-text">
                {config.passwordSet ? (config.password ?? "") : "Sin valor"}
              </p>
            </div>
            <Field
              label="Rcon nuevo"
              htmlFor="cfg-rcon"
              error={fieldErrors.rcon}
              hint="Vacío = sin cambio."
            >
              <input
                id="cfg-rcon"
                type="password"
                value={rconInput}
                autoComplete="new-password"
                onChange={(event) => setRconInput(event.target.value)}
                className={inputClass(fieldErrors.rcon)}
              />
            </Field>
            <Field
              label="Password nuevo"
              htmlFor="cfg-password"
              error={fieldErrors.password}
              hint="Vacío = sin cambio."
            >
              <input
                id="cfg-password"
                type="password"
                value={passwordInput}
                autoComplete="new-password"
                onChange={(event) => setPasswordInput(event.target.value)}
                className={inputClass(fieldErrors.password)}
              />
            </Field>
          </div>
        </Panel>

        <Panel title="Avanzado (solo lectura)">
          <p className="type-caption mb-3 text-text-2">
            Estas líneas del server.cfg no se editan desde el panel y se preservan tal cual al
            guardar.
          </p>
          <pre className="type-mono overflow-x-auto rounded-sm border border-border bg-surface-2 p-3 text-text-2">
            {config.unknownLines.length > 0
              ? config.unknownLines.join("\n")
              : "— Sin líneas adicionales —"}
          </pre>
        </Panel>
      </div>

      {/* Toolbar de acciones */}
      <div className="sticky bottom-0 mt-6 flex flex-col gap-3 border-t border-border bg-bg py-4 sm:flex-row sm:items-center sm:justify-between">
        <Button
          variant="danger"
          onClick={() => setShowRestartModal(true)}
          disabled={saving}
        >
          <Power size={16} strokeWidth={1.75} aria-hidden="true" />
          Reiniciar server
        </Button>
        <Button onClick={() => void handleSave()} disabled={!dirty} loading={saving}>
          {saving ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>

      <ConfirmModal
        open={showRestartModal}
        title="¿Reiniciar el server?"
        confirmLabel="Reiniciar"
        loading={restarting}
        onCancel={() => setShowRestartModal(false)}
        onConfirm={() => void handleRestart()}
      >
        El server dedicado se detiene y arranca de nuevo con la configuración guardada. Los
        jugadores conectados se verán desconectados.
      </ConfirmModal>
    </div>
  );
}


