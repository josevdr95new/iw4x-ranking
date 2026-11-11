import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  Dices,
  KeyRound,
  Link2Off,
  PencilLine,
  RefreshCcw,
  Search,
  SearchX,
  ShieldCheck,
  Trash2,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../../lib/api";
import type { AccountRole, AdminAccount, AdminAccountDetail } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { Panel } from "../../components/ui/Panel";
import { Skeleton, Spinner } from "../../components/ui/Spinner";
import { useAuth } from "../../lib/auth";
import { formatFullDate, formatGuid, formatInt, formatRelative } from "../../lib/format";

const MIN_PASSWORD_LENGTH = 8;
const GENERATED_PASSWORD_LENGTH = 16;

/* Contraseñas generadas: sin caracteres ambiguos (0/O, 1/l/I) y con las 4 clases. */
const PASSWORD_POOLS = {
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  lower: "abcdefghijkmnopqrstuvwxyz",
  digit: "23456789",
  symbol: "!@#$%&*+-",
} as const;

/** Contraseña aleatoria cripto-segura (16 chars, ≥1 de cada clase, orden barajado). */
function generatePassword(length = GENERATED_PASSWORD_LENGTH): string {
  const pools = Object.values(PASSWORD_POOLS);
  const all = pools.join("");
  const randomInt = (max: number): number => {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] % max;
  };
  const pick = (source: string): string => source[randomInt(source.length)];
  const chars: string[] = pools.map((pool) => pick(pool));
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const temp = chars[i];
    chars[i] = chars[j];
    chars[j] = temp;
  }
  return chars.join("");
}

/** Mensaje humano para errores de negocio de cuentas (patrón rconErrorText). */
function accountErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "ACCOUNT_LAST_ADMIN":
        return "es el último administrador de la comunidad: asciende a otro admin antes de quitárselo";
      case "ACCOUNT_SELF_DELETE":
        return "no puedes borrar tu propia cuenta desde el panel";
      case "ACCOUNT_NICK_TAKEN":
        return "ese nick ya está en uso por otra cuenta";
      case "ACCOUNT_EMAIL_TAKEN":
        return "ese email ya está registrado en otra cuenta";
      case "ACCOUNT_WEAK_PASSWORD":
        return `la contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
      case "ACCOUNT_NOT_FOUND":
        return "la cuenta ya no existe: otro admin la borró mientras actuabas";
      default:
        return error.message;
    }
  }
  return "No hay conexión con el servidor.";
}

type AccountsState =
  | { phase: "loading" }
  | { phase: "error"; text: string }
  | { phase: "ready"; accounts: AdminAccount[] };

type DetailState =
  | { phase: "loading" }
  | { phase: "error"; text: string }
  | { phase: "ready"; account: AdminAccountDetail };

/** Chip de rol: ADMIN destaca en verde (privilegio alto), USER queda neutro. */
function RoleChip({ role }: { role: AccountRole }) {
  return role === "ADMIN" ? <Badge variant="success">ADMIN</Badge> : <Badge variant="neutral">USER</Badge>;
}

/* --- Modal: cambiar contraseña --- */

function PasswordModal({
  account,
  onClose,
  onDone,
}: {
  account: AdminAccount;
  onClose: () => void;
  onDone: (account: AdminAccount) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const handleGenerate = () => {
    const next = generatePassword();
    setPassword(next);
    setConfirm("");
    setGenerated(next);
    setCopied(false);
    setValidationError(null);
    setErrorText(null);
  };

  const handleCopy = async () => {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Portapapeles no disponible: la contraseña sigue visible para copiarla a mano.
    }
  };

  const handleSubmit = async () => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setValidationError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (generated === null && password !== confirm) {
      setValidationError("Las contraseñas no coinciden.");
      return;
    }
    setSubmitting(true);
    setValidationError(null);
    setErrorText(null);
    try {
      await api.adminSetAccountPassword(account.id, password);
      onDone(account);
    } catch (error) {
      setErrorText(accountErrorText(error));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[rgba(11,12,9,0.7)]"
        onClick={submitting ? undefined : onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-password-title"
        className="relative w-full max-w-[460px] rounded-lg border border-border bg-surface p-5 shadow-modal"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="account-password-title" className="type-display-m text-text">
            Contraseña nueva · {account.displayName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            disabled={submitting}
            className="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <p className="type-caption mt-1 text-text-2">
          Aplica al instante y sustituye su contraseña actual. Cópiasela al jugador por un canal seguro.
        </p>

        <div className="mt-4 flex flex-col gap-4">
          <Input
            label={`Nueva contraseña (mín. ${MIN_PASSWORD_LENGTH})`}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            passwordToggle
            autoComplete="new-password"
            error={validationError ?? undefined}
            disabled={submitting}
          />
          {generated === null ? (
            <>
              <button
                type="button"
                onClick={handleGenerate}
                className="type-button inline-flex h-8 items-center gap-2 self-start rounded-sm px-2 text-[12px] text-accent transition-colors duration-150 ease-out hover:bg-accent-subtle"
              >
                <Dices size={16} strokeWidth={1.75} aria-hidden="true" />
                Generar aleatoria
              </button>
              <Input
                label="Confirmar contraseña"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                passwordToggle
                autoComplete="new-password"
                disabled={submitting}
              />
            </>
          ) : (
            <div className="rounded-sm border border-accent-border bg-accent-subtle px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <code className="type-mono min-w-0 break-all text-text" aria-label="Contraseña generada">
                  {generated}
                </code>
                <Button size="sm" variant="ghost" className="shrink-0" onClick={() => void handleCopy()}>
                  {copied ? (
                    <Check size={14} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  {copied ? "Copiada" : "Copiar"}
                </Button>
              </div>
              <p className="type-caption mt-1.5 text-text-2">
                16 caracteres ya fijados como contraseña de arriba. Cópiala antes de guardar: no se volverá a
                mostrar.
              </p>
            </div>
          )}
        </div>

        {errorText && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger-hover"
          >
            <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{errorText}</span>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Volver
          </Button>
          <Button onClick={() => void handleSubmit()} loading={submitting}>
            Guardar contraseña
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --- Modal: editar cuenta (nick + email) --- */

function EditAccountModal({
  account,
  onClose,
  onDone,
}: {
  account: AdminAccount;
  onClose: () => void;
  onDone: (account: AdminAccount) => void;
}) {
  const [displayName, setDisplayName] = useState(account.displayName);
  const [email, setEmail] = useState(account.email);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmedName = displayName.trim();
    const trimmedEmail = email.trim();
    if (trimmedName.length === 0) {
      setValidationError("El nick no puede quedar vacío.");
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
      setValidationError("Escribe un email válido.");
      return;
    }
    setSubmitting(true);
    setValidationError(null);
    setErrorText(null);
    try {
      const response = await api.adminUpdateAccount(account.id, {
        displayName: trimmedName,
        email: trimmedEmail,
      });
      onDone(response.account);
    } catch (error) {
      setErrorText(accountErrorText(error));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[rgba(11,12,9,0.7)]"
        onClick={submitting ? undefined : onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-edit-title"
        className="relative w-full max-w-[460px] rounded-lg border border-border bg-surface p-5 shadow-modal"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="account-edit-title" className="type-display-m text-text">
            Editar cuenta · {account.displayName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            disabled={submitting}
            className="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-4">
          <Input
            label="Nick"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={40}
            autoComplete="off"
            error={validationError ?? undefined}
            disabled={submitting}
          />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={120}
            autoComplete="off"
            disabled={submitting}
          />
          <p className="type-caption text-text-2">
            El nick reserva el nombre en el juego (anti-suplantación); el email es el identificador de login.
          </p>
        </div>

        {errorText && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger-hover"
          >
            <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{errorText}</span>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Volver
          </Button>
          <Button onClick={() => void handleSubmit()} loading={submitting}>
            Guardar cambios
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --- Modal: borrar cuenta (confirmación escribiendo el nombre) --- */

function DeleteAccountModal({
  account,
  onClose,
  onDone,
}: {
  account: AdminAccount;
  onClose: () => void;
  onDone: (account: AdminAccount) => void;
}) {
  const [typedName, setTypedName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const canDelete = typedName.trim() === account.displayName;

  const handleSubmit = async () => {
    if (!canDelete) return;
    setSubmitting(true);
    setErrorText(null);
    try {
      await api.adminDeleteAccount(account.id);
      onDone(account);
    } catch (error) {
      setErrorText(accountErrorText(error));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[rgba(11,12,9,0.7)]"
        onClick={submitting ? undefined : onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-delete-title"
        className="relative w-full max-w-[460px] rounded-lg border border-border bg-surface p-5 shadow-modal"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="account-delete-title" className="type-display-m text-text">
            Borrar cuenta · {account.displayName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            disabled={submitting}
            className="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2.5 text-sm text-danger-hover"
        >
          <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
          <p>
            Esto <strong className="font-semibold text-danger">borra los links, sesiones y saves en la
            nube</strong> de la cuenta. Los guids quedan libres: ese jugador podrá vincularse de nuevo desde
            cero.
          </p>
        </div>

        <div className="mt-4">
          <Input
            label={`Escribe «${account.displayName}» para confirmar`}
            value={typedName}
            onChange={(event) => setTypedName(event.target.value)}
            autoComplete="off"
            autoFocus
            disabled={submitting}
          />
        </div>

        {errorText && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger-hover"
          >
            <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{errorText}</span>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Volver
          </Button>
          <Button
            variant="danger"
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={!canDelete}
          >
            Borrar cuenta
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --- Detalle expandido: guids + save + sesiones --- */

function AccountDetailRow({
  rowId,
  state,
  onRetry,
  onClose,
  onUnlink,
  unlinkConfirmGuid,
  unlinkBusyGuid,
  unlinkError,
  onBeginUnlink,
  onCancelUnlink,
}: {
  rowId: string;
  state: DetailState;
  onRetry: () => void;
  onClose: () => void;
  onUnlink: (account: AdminAccountDetail, guid: string) => void;
  unlinkConfirmGuid: string | null;
  unlinkBusyGuid: string | null;
  unlinkError: { guid: string; text: string } | null;
  onBeginUnlink: (guid: string) => void;
  onCancelUnlink: () => void;
}) {
  if (state.phase === "loading") {
    return (
      <tr>
        <td id={rowId} colSpan={6} className="border-b border-border bg-surface-2/40 px-5 py-4">
          <div className="flex items-center gap-2" aria-live="polite">
            <Spinner size={16} />
            <span className="type-caption text-text-2">Cargando detalle de la cuenta…</span>
          </div>
        </td>
      </tr>
    );
  }

  if (state.phase === "error") {
    return (
      <tr>
        <td id={rowId} colSpan={6} className="border-b border-border bg-surface-2/40 px-5 py-4">
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <span className="type-body text-danger-hover">{state.text}</span>
            <Button size="sm" variant="ghost" onClick={onRetry}>
              <RefreshCcw size={14} strokeWidth={1.75} aria-hidden="true" />
              Reintentar
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Ocultar
            </Button>
          </div>
        </td>
      </tr>
    );
  }

  const account = state.account;
  const save = account.save;

  return (
    <tr>
      <td id={rowId} colSpan={6} className="border-b border-border bg-surface-2/40 px-5 py-4">
        <p className="type-caption text-text-2">
          Cuenta #{account.id} · creada {formatFullDate(account.createdAt)} · email{" "}
          <span className="text-text">{account.email}</span>
        </p>
        <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          {/* GUIDs vinculados */}
          <div className="min-w-0">
            <h3 className="type-label text-text-2">Guids vinculados ({formatInt(account.guids.length)})</h3>
            {account.guids.length === 0 ? (
              <p className="type-caption mt-2 text-text-2">
                Sin guids vinculados: el jugador puede vincularse desde el launcher.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {account.guids.map((entry) => {
                  const confirming = unlinkConfirmGuid === entry.guid;
                  const busy = unlinkBusyGuid === entry.guid;
                  return (
                    <li key={entry.guid} className="py-2 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="type-mono text-text" title={entry.guid}>
                          {formatGuid(entry.guid)}
                        </span>
                        <span className="type-caption text-text-2">
                          {entry.lastSeen ? `visto ${formatRelative(entry.lastSeen)}` : "nunca visto"}
                        </span>
                        {confirming ? (
                          <span className="ml-auto inline-flex flex-wrap items-center gap-1.5">
                            <span className="type-caption text-text">
                              ¿Desvincular? Dejará de entrar con este guid a la cuenta.
                            </span>
                            <button
                              type="button"
                              onClick={onCancelUnlink}
                              disabled={busy}
                              className="type-button h-8 rounded-sm px-2 text-[12px] text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text"
                            >
                              Volver
                            </button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => onUnlink(account, entry.guid)}
                              loading={busy}
                              aria-label={`Confirmar desvinculación del guid ${entry.guid}`}
                            >
                              Desvincular
                            </Button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onBeginUnlink(entry.guid)}
                            disabled={unlinkBusyGuid !== null}
                            title={`Desvincular el guid ${entry.guid} de esta cuenta`}
                            className="type-button ml-auto inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-[12px] text-text-2 transition-colors duration-150 ease-out hover:bg-danger/10 hover:text-danger-hover disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Link2Off size={14} strokeWidth={1.75} aria-hidden="true" />
                            Desvincular
                          </button>
                        )}
                      </div>
                      {unlinkError?.guid === entry.guid && (
                        <p role="alert" className="type-caption mt-1 text-danger-hover">
                          {unlinkError.text}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="type-caption mt-2 text-text-2">
              Desvincular libera el guid: deja de autenticar como esta cuenta (anti-suplantación).
            </p>
          </div>

          {/* Save + sesiones */}
          <div className="grid grid-cols-2 gap-4 divide-x divide-border">
            <div className="pr-4">
              <h3 className="type-label text-text-2">Save en la nube</h3>
              {save ? (
                <>
                  <p className="type-number-l mt-1.5 text-text">Nivel {formatInt(save.level)}</p>
                  <p className="type-caption mt-1 text-text-2">
                    {formatInt(save.xp)} XP · parseado {formatRelative(save.parsedAt)}
                  </p>
                </>
              ) : (
                <p className="type-caption mt-1.5 text-text-2">Sin save en la nube.</p>
              )}
            </div>
            <div className="pl-4">
              <h3 className="type-label text-text-2">Sesiones</h3>
              <p className="type-number-l mt-1.5 text-text">{formatInt(account.sessions)}</p>
              <p className="type-caption mt-1 text-text-2">sesiones de launcher activas</p>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

/* --- Panel principal --- */

export function AccountsPanel() {
  const { user: viewer } = useAuth();
  const [accountsState, setAccountsState] = useState<AccountsState>({ phase: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [filterInput, setFilterInput] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);

  const [passwordModal, setPasswordModal] = useState<AdminAccount | null>(null);
  const [editModal, setEditModal] = useState<AdminAccount | null>(null);
  const [roleConfirm, setRoleConfirm] = useState<{ account: AdminAccount; next: AccountRole } | null>(null);
  const [roleBusy, setRoleBusy] = useState(false);
  const [deleteModal, setDeleteModal] = useState<AdminAccount | null>(null);

  const [unlinkConfirmGuid, setUnlinkConfirmGuid] = useState<string | null>(null);
  const [unlinkBusyGuid, setUnlinkBusyGuid] = useState<string | null>(null);
  const [unlinkError, setUnlinkError] = useState<{ guid: string; text: string } | null>(null);

  /* Listado de cuentas: conservar los datos listados mientras se re-lista tras una acción. */
  useEffect(() => {
    let cancelled = false;
    setAccountsState((state) => (state.phase === "ready" ? state : { phase: "loading" }));
    api
      .adminAccounts()
      .then((response) => {
        if (cancelled) return;
        setAccountsState({ phase: "ready", accounts: response.accounts });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAccountsState({ phase: "error", text: accountErrorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /* Detalle de la cuenta expandida (guids, save, sesiones). */
  useEffect(() => {
    if (detailId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail({ phase: "loading" });
    api
      .adminAccount(detailId)
      .then((response) => {
        if (cancelled) return;
        setDetail({ phase: "ready", account: response.account });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDetail({ phase: "error", text: accountErrorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [detailId, detailReloadKey]);

  /** Relista la tabla y el detalle abierto tras cada acción. */
  const refreshAfterAction = useCallback(() => {
    setReloadKey((key) => key + 1);
    setDetailReloadKey((key) => key + 1);
  }, []);

  const toggleDetail = (id: number) => {
    setUnlinkConfirmGuid(null);
    setUnlinkError(null);
    setDetailId((current) => (current === id ? null : id));
  };

  const executeRoleChange = async () => {
    if (!roleConfirm) return;
    const { account, next } = roleConfirm;
    setRoleBusy(true);
    try {
      await api.adminUpdateAccount(account.id, { role: next });
      setRoleConfirm(null);
      setNotice({
        ok: true,
        text: `${account.displayName} ahora es ${next === "ADMIN" ? "ADMIN" : "USER"}.`,
      });
      refreshAfterAction();
    } catch (error) {
      setRoleConfirm(null);
      setNotice({
        ok: false,
        text: `No se pudo cambiar el rol de ${account.displayName}: ${accountErrorText(error)}.`,
      });
    } finally {
      setRoleBusy(false);
    }
  };

  const executeUnlink = async (account: AdminAccountDetail, guid: string) => {
    setUnlinkBusyGuid(guid);
    setUnlinkError(null);
    try {
      await api.adminUnlinkAccountGuid(account.id, guid);
      setUnlinkConfirmGuid(null);
      setNotice({ ok: true, text: `Guid desvinculado de ${account.displayName}: ${guid}` });
      refreshAfterAction();
    } catch (error) {
      setUnlinkError({ guid, text: accountErrorText(error) });
    } finally {
      setUnlinkBusyGuid(null);
    }
  };

  const accounts = accountsState.phase === "ready" ? accountsState.accounts : [];
  const filtered = useMemo(() => {
    const query = filterInput.trim().toLowerCase();
    if (query.length === 0) return accounts;
    return accounts.filter(
      (account) =>
        account.displayName.toLowerCase().includes(query) || account.email.toLowerCase().includes(query),
    );
  }, [accounts, filterInput]);

  const adminsCount = accounts.filter((account) => account.role === "ADMIN").length;

  if (accountsState.phase === "loading") {
    return (
      <div aria-hidden="true" className="space-y-4">
        <div className="rounded-md border border-border bg-surface p-5">
          <Skeleton className="h-3 w-64" />
          <div className="mt-4 space-y-2.5">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex items-center justify-between gap-4">
                <Skeleton className="h-3" style={{ width: `${55 - index * 8}%` }} />
                <Skeleton className="h-3 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (accountsState.phase === "error") {
    return (
      <div className="rounded-md border border-border bg-surface">
        <EmptyState
          icon={WifiOff}
          title="No pudimos cargar las cuentas."
          description={accountsState.text}
          action={
            <Button size="sm" variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
              <RefreshCcw size={14} strokeWidth={1.75} aria-hidden="true" />
              Reintentar
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div>
      {/* Resumen */}
      <div
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-surface px-4 py-3"
      >
        <span className="type-label inline-flex items-center gap-2 text-accent">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
          {formatInt(accounts.length)} {accounts.length === 1 ? "cuenta" : "cuentas"} ·{" "}
          {formatInt(adminsCount)} {adminsCount === 1 ? "administrador" : "administradores"}
        </span>
        <span className="type-caption text-text-2">
          Contraseñas, nicks, emails, roles y guids se aplican al instante.
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

      <div className="mt-4">
        <Panel
          title="Cuentas web"
          caption={
            filterInput.trim().length > 0
              ? `${formatInt(filtered.length)} de ${formatInt(accounts.length)} cuentas coinciden con «${filterInput.trim()}».`
              : "Contraseñas, nicks, roles, guids y borrado de las cuentas de la comunidad."
          }
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => refreshAfterAction()}
              aria-label="Actualizar cuentas ahora"
            >
              <RefreshCcw size={16} strokeWidth={1.75} aria-hidden="true" />
              Actualizar
            </Button>
          }
        >
          {accounts.length > 0 && (
            <div className="mb-4 max-w-[360px]">
              <Input
                label=""
                aria-label="Filtrar cuentas por nick o email"
                icon={<Search size={16} strokeWidth={1.75} aria-hidden="true" />}
                placeholder="Filtrar por nick o email…"
                value={filterInput}
                onChange={(event) => setFilterInput(event.target.value)}
                autoComplete="off"
              />
            </div>
          )}

          {accounts.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Aún no hay cuentas registradas."
              description="Cuando alguien cree una cuenta en la web o se vincule desde el launcher, aparecerá aquí."
            />
          ) : filtered.length === 0 ? (
            <div className="rounded-md border border-border">
              <EmptyState
                icon={SearchX}
                title={`Ninguna cuenta coincide con «${filterInput.trim()}».`}
                description="Prueba con otro nick o con el email completo."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <caption className="sr-only">
                  Cuentas web de la comunidad, con rol, guids vinculados y acciones de administración.
                </caption>
                <thead>
                  <tr className="bg-surface">
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Jugador</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Email</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Rol</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right">
                      <span className="type-label text-text-2">Guids</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right">
                      <span className="type-label text-text-2">Creado</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right">
                      <span className="type-label text-text-2">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((account) => {
                    const detailOpen = detailId === account.id;
                    const isSelf = viewer?.id === account.id;
                    const nextRole: AccountRole = account.role === "ADMIN" ? "USER" : "ADMIN";
                    return (
                      <Fragment key={account.id}>
                        <tr className="border-b border-border transition-colors duration-150 ease-out hover:bg-surface-2">
                          <td className="max-w-[200px] px-3 py-2.5">
                            <span
                              className="block truncate text-sm font-semibold text-text"
                              title={account.displayName}
                            >
                              {account.displayName}
                            </span>
                            <span className="type-caption block text-text-2">#{account.id}</span>
                          </td>
                          <td className="max-w-[220px] truncate px-3 py-2.5">
                            <span className="type-body block truncate text-text-2" title={account.email}>
                              {account.email}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <RoleChip role={account.role} />
                          </td>
                          <td data-numeric className="px-3 py-2.5 text-right">
                            <span
                              className={`type-number-m ${account.guidCount === 0 ? "text-text-2" : "text-text"}`}
                            >
                              {formatInt(account.guidCount)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <span
                              className="type-caption whitespace-nowrap text-text-2"
                              title={formatFullDate(account.createdAt)}
                            >
                              {formatRelative(account.createdAt)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="inline-flex items-center gap-0.5 whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => toggleDetail(account.id)}
                                aria-expanded={detailOpen}
                                aria-controls={`account-detail-${account.id}`}
                                title={detailOpen ? "Ocultar detalle" : "Ver guids, save y sesiones"}
                                className="type-button inline-flex h-8 items-center gap-1 rounded-sm px-2 text-[12px] text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text"
                              >
                                {detailOpen ? (
                                  <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
                                ) : (
                                  <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
                                )}
                                Detalle
                              </button>
                              <button
                                type="button"
                                onClick={() => setPasswordModal(account)}
                                title={`Cambiar contraseña de ${account.displayName}`}
                                aria-label={`Cambiar contraseña de ${account.displayName}`}
                                className="type-button inline-flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text"
                              >
                                <KeyRound size={15} strokeWidth={1.75} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditModal(account)}
                                title={`Editar nick y email de ${account.displayName}`}
                                aria-label={`Editar nick y email de ${account.displayName}`}
                                className="type-button inline-flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text"
                              >
                                <PencilLine size={15} strokeWidth={1.75} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setRoleConfirm({ account, next: nextRole })}
                                title={
                                  nextRole === "ADMIN"
                                    ? `Ascender a ${account.displayName} a ADMIN`
                                    : `Quitar ADMIN a ${account.displayName}`
                                }
                                aria-label={
                                  nextRole === "ADMIN"
                                    ? `Ascender a ${account.displayName} a ADMIN`
                                    : `Quitar ADMIN a ${account.displayName}`
                                }
                                className="type-button inline-flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-accent-subtle hover:text-accent"
                              >
                                <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteModal(account)}
                                disabled={isSelf}
                                title={
                                  isSelf
                                    ? "No puedes borrar tu propia cuenta"
                                    : `Borrar la cuenta de ${account.displayName}`
                                }
                                aria-label={`Borrar la cuenta de ${account.displayName}`}
                                className="type-button inline-flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-danger/10 hover:text-danger-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-2"
                              >
                                <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                        {detailOpen && detail !== null && (
                          <AccountDetailRow
                            rowId={`account-detail-${account.id}`}
                            state={detail}
                            onRetry={() => setDetailReloadKey((key) => key + 1)}
                            onClose={() => setDetailId(null)}
                            onUnlink={(rowAccount, guid) => void executeUnlink(rowAccount, guid)}
                            unlinkConfirmGuid={unlinkConfirmGuid}
                            unlinkBusyGuid={unlinkBusyGuid}
                            unlinkError={unlinkError}
                            onBeginUnlink={(guid) => {
                              setUnlinkConfirmGuid(guid);
                              setUnlinkError(null);
                            }}
                            onCancelUnlink={() => setUnlinkConfirmGuid(null)}
                          />
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {passwordModal && (
        <PasswordModal
          account={passwordModal}
          onClose={() => setPasswordModal(null)}
          onDone={(account) => {
            setPasswordModal(null);
            setNotice({ ok: true, text: `Contraseña actualizada: ${account.displayName}.` });
          }}
        />
      )}

      {editModal && (
        <EditAccountModal
          account={editModal}
          onClose={() => setEditModal(null)}
          onDone={(updated) => {
            setEditModal(null);
            setNotice({ ok: true, text: `Cuenta actualizada: ${updated.displayName} · ${updated.email}.` });
            refreshAfterAction();
          }}
        />
      )}

      {roleConfirm && (
        <ConfirmModal
          open
          title="Cambiar rol"
          confirmLabel={roleConfirm.next === "ADMIN" ? "Hacer ADMIN" : "Quitar ADMIN"}
          loading={roleBusy}
          onConfirm={() => void executeRoleChange()}
          onCancel={() => {
            if (!roleBusy) setRoleConfirm(null);
          }}
        >
          {roleConfirm.next === "ADMIN" ? (
            <p>
              <strong className="font-semibold text-text">{roleConfirm.account.displayName}</strong> podrá
              entrar a /admin: config del server, moderación, identidad y cuentas.
            </p>
          ) : (
            <p>
              <strong className="font-semibold text-text">{roleConfirm.account.displayName}</strong> dejará de
              ser administrador y perderá el acceso al panel.
            </p>
          )}
        </ConfirmModal>
      )}

      {deleteModal && (
        <DeleteAccountModal
          account={deleteModal}
          onClose={() => setDeleteModal(null)}
          onDone={(account) => {
            setDeleteModal(null);
            if (detailId === account.id) setDetailId(null);
            setNotice({ ok: true, text: `Cuenta eliminada: ${account.displayName}.` });
            setReloadKey((key) => key + 1);
          }}
        />
      )}
    </div>
  );
}
