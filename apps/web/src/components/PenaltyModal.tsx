import { AlertCircle } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../lib/api";
import type { IamPenaltyRecordType, IamPenaltyResponse, IamPenaltyType } from "../lib/api";
import { Button } from "./ui/Button";

/** Los nombres del upstream traen códigos de color del juego (^1…): se limpian para el UI (API.md §Moderación). */
export function stripColorCodes(value: string | null): string {
  return (value ?? "").replace(/\^[0-9a-zA-Z]/g, "").trim() || "—";
}

export const PENALTY_TYPE_LABEL: Record<IamPenaltyRecordType, string> = {
  warn: "WARN",
  kick: "KICK",
  tempban: "TEMPBAN",
  ban: "BAN",
  unban: "UNBAN",
};

export interface PenaltyTarget {
  name: string;
  /** Player.id del ranking (preferente: permite tempban/ban offline). */
  clientId?: number | null;
  /** Slot directo del server (status). Imprescindible para bots: llegan con clientId null. */
  cid?: number | null;
  /** true → el target es un bot: warn/tempban/ban devuelven TARGET_IS_BOT (solo kick). */
  isBot?: boolean;
}

const REASON_MIN = 3;
const REASON_MAX = 200;

const TEMPBAN_PRESETS = [
  { label: "1 h", minutes: 60 },
  { label: "24 h", minutes: 1440 },
  { label: "7 d", minutes: 10080 },
] as const;

const PENALTY_ACTION: Record<IamPenaltyType, string> = {
  warn: "Emitir warn",
  kick: "Expulsar",
  tempban: "Aplicar tempban",
  ban: "Confirmar ban permanente",
};

const TYPE_CHOICES: IamPenaltyType[] = ["warn", "kick", "tempban", "ban"];

/** Modal único de penalidad: motivo SIEMPRE obligatorio (≥3 chars); tempban pide preset; ban marca PERMANENTE en rojo.
 *  Con `allowTypeChoice` muestra un selector de tipo (sección EN VIVO: "Castigar…" pre-rellena el target y deja elegir).
 *  Errores de negocio de la API se traducen a copy claro: TARGET_IS_BOT (bots solo admiten kick) y CID_MISMATCH (slot rotó,
 *  anti-TOCTOU — nada se envió; "Reintentar" vuelve a intentar contra el estado fresco del server). */
export function PenaltyModal({
  target,
  type: initialType,
  allowTypeChoice = false,
  initialReason = "",
  onClose,
  onDone,
}: {
  target: PenaltyTarget;
  type: IamPenaltyType;
  /** true → muestra selector WARN/KICK/TEMPBAN/BAN dentro del modal (default: tipo fijo). */
  allowTypeChoice?: boolean;
  /** Motivo prellenado (opcional; sigue siendo editable). */
  initialReason?: string;
  onClose: () => void;
  onDone: (response: IamPenaltyResponse) => void;
}) {
  const [type, setType] = useState<IamPenaltyType>(initialType);
  const [reason, setReason] = useState(initialReason);
  const [durationMinutes, setDurationMinutes] = useState<number>(TEMPBAN_PRESETS[0].minutes);
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);

  const cleanReason = reason.trim();
  const reasonError =
    cleanReason.length > 0 && (cleanReason.length < REASON_MIN || cleanReason.length > REASON_MAX)
      ? `El motivo debe tener entre ${REASON_MIN} y ${REASON_MAX} caracteres.`
      : null;
  const hasTarget = target.clientId !== null && target.clientId !== undefined ? true : target.cid !== null && target.cid !== undefined;
  const canSubmit = !submitting && !reasonError && cleanReason.length >= REASON_MIN && hasTarget;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorText(null);
    setRetryable(false);
    try {
      const response = await api.iamPenalty({
        type,
        reason: cleanReason,
        ...(target.clientId !== null && target.clientId !== undefined
          ? { clientId: target.clientId }
          : { cid: target.cid as number }),
        ...(type === "tempban" ? { durationMinutes } : {}),
      });
      onDone(response);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "TARGET_IS_BOT") {
          setErrorText("Es un bot del server: los bots no se pueden banear — kickealos para liberar el slot.");
        } else if (error.code === "CID_MISMATCH") {
          setErrorText("El slot cambió de jugador — reintenta.");
          setRetryable(true);
        } else {
          const fieldIssues = error.details?.issues ?? [];
          const issueText = fieldIssues.map((issue) => issue.message).join(" ");
          setErrorText(issueText || error.message);
        }
      } else {
        setErrorText("No se pudo emitir la penalidad. Inténtalo de nuevo.");
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[rgba(11,12,9,0.7)]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="penalty-modal-title"
        className="relative w-full max-w-[460px] rounded-lg border border-border bg-surface p-5 shadow-modal"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="penalty-modal-title" className="type-display-m text-text">
            <span className="sr-only">{PENALTY_TYPE_LABEL[type]} para </span>
            {PENALTY_TYPE_LABEL[type]} · {stripColorCodes(target.name)}
          </h2>
        </div>

        {allowTypeChoice && (
          <div className="mt-4">
            <span className="type-label text-text-2">Tipo</span>
            <div className="mt-1.5 flex" role="group" aria-label="Tipo de penalidad">
              {TYPE_CHOICES.map((choice) => {
                const active = type === choice;
                return (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => setType(choice)}
                    aria-pressed={active}
                    className={`type-button h-9 flex-1 rounded-sm px-2 text-[12px] transition-colors duration-150 ease-out ${
                      active
                        ? "border border-accent-border bg-accent-subtle text-accent"
                        : "text-text-2 hover:text-text"
                    }`}
                  >
                    {PENALTY_TYPE_LABEL[choice]}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {target.isBot && type !== "kick" && (
          <div className="mt-3 flex items-start gap-2 rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
            <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
            <p>Es un bot del server: los bots no se pueden banear — kickealos.</p>
          </div>
        )}

        {type === "ban" && (
          <div className="mt-3 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-hover">
            <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
            <p>
              Este ban es <strong className="font-semibold text-danger">permanente</strong>. Queda en
              bans.json del server y sobrevive reinicios.
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-1.5">
          <label htmlFor="penalty-reason" className="type-label text-text-2">
            Motivo <span className="text-danger">*</span>
          </label>
          <textarea
            id="penalty-reason"
            value={reason}
            rows={3}
            maxLength={REASON_MAX}
            aria-invalid={reasonError ? true : undefined}
            autoFocus
            placeholder={`Ej.: ${type === "warn" ? "lenguaje ofensivo en chat" : "uso de cheat detectado"}`}
            onChange={(event) => setReason(event.target.value)}
            className={`min-h-[72px] w-full rounded-sm border bg-surface-2 px-3 py-2 text-text transition-colors duration-150 ease-out focus:border-accent focus:shadow-[0_0_0_1px_#8FD429] focus:outline-none ${
              reasonError ? "border-danger" : "border-border"
            }`}
          />
          {reasonError && (
            <p role="alert" className="flex items-start gap-1.5 text-[13px] text-danger-hover">
              <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
              {reasonError}
            </p>
          )}
          {!hasTarget && (
            <p role="alert" className="flex items-start gap-1.5 text-[13px] text-danger-hover">
              <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
              Este jugador no tiene clientId ni slot (cid): no se le puede emitir una penalidad.
            </p>
          )}
          <p className="type-caption text-text-2">
            El motivo viaja al juego y queda registrado en la base de penalidades.
          </p>
        </div>

        {type === "tempban" && (
          <div className="mt-4">
            <span className="type-label text-text-2">Duración</span>
            <div className="mt-1.5 flex" role="group" aria-label="Duración del tempban">
              {TEMPBAN_PRESETS.map((preset) => {
                const active = durationMinutes === preset.minutes;
                return (
                  <button
                    key={preset.minutes}
                    type="button"
                    onClick={() => setDurationMinutes(preset.minutes)}
                    aria-pressed={active}
                    className={`type-button h-9 flex-1 rounded-sm px-3 transition-colors duration-150 ease-out ${
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
          </div>
        )}

        {errorText && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger-hover"
          >
            <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{errorText}</span>
            {retryable && (
              <Button size="sm" variant="ghost" className="shrink-0" onClick={() => void handleSubmit()} disabled={submitting}>
                Reintentar
              </Button>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Volver
          </Button>
          <Button
            variant={type === "warn" ? "primary" : "danger"}
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            loading={submitting}
          >
            {submitting ? "Enviando…" : PENALTY_ACTION[type]}
          </Button>
        </div>
      </div>
    </div>
  );
}
