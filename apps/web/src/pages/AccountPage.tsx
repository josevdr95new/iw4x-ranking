import { Check, Link2, ShieldAlert, Unlink } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/Button";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { formatGuid, formatRelative } from "../lib/format";

const MIN_PASSWORD_LENGTH = 8;

interface ProfileErrors {
  displayName?: string;
  form?: string;
}

interface PasswordErrors {
  currentPassword?: string;
  password?: string;
  confirmPassword?: string;
  form?: string;
}

function SavedLine({ children }: { children: string }) {
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 rounded-sm border border-accent-border bg-accent-subtle px-3 py-2 text-[13px] text-accent"
    >
      <Check size={14} strokeWidth={1.75} aria-hidden="true" />
      {children}
    </p>
  );
}

function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h2 className="type-display-m text-text">{title}</h2>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function AccountPage() {
  const { user, initializing, refresh } = useAuth();

  // Perfil
  const [displayName, setDisplayName] = useState("");
  const [profileErrors, setProfileErrors] = useState<ProfileErrors>({});
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  // Contraseña
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordErrors, setPasswordErrors] = useState<PasswordErrors>({});
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);

  // Desvinculación
  const [pendingUnlink, setPendingUnlink] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  useEffect(() => {
    if (user) setDisplayName(user.displayName);
  }, [user]);

  if (initializing) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={20} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="rounded-md border border-border bg-surface">
        <EmptyState
          icon={ShieldAlert}
          title="Necesitas una cuenta."
          description="Inicia sesión para gestionar tu perfil y tus GUIDs vinculados."
          action={
            <Link to="/login" state={{ from: "/account" }}>
              <Button>Entrar</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const handleSaveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProfileErrors({});
    setProfileSaved(false);
    const name = displayName.trim();
    if (name.length < 3 || name.length > 32) {
      setProfileErrors({ displayName: "El nombre debe tener entre 3 y 32 caracteres." });
      return;
    }
    if (name === user.displayName) return;

    setSavingProfile(true);
    try {
      await api.updateMe({ displayName: name });
      await refresh();
      setProfileSaved(true);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "NICK_TAKEN") {
          setProfileErrors({
            displayName:
              error.message.trim().length > 0
                ? error.message
                : "Ese nick ya está reservado por otra cuenta.",
          });
        } else {
          const fieldErrors = error.fieldErrors();
          if (fieldErrors.displayName) {
            setProfileErrors({ displayName: fieldErrors.displayName });
          } else {
            setProfileErrors({ form: "No se pudo guardar. Inténtalo de nuevo." });
          }
        }
      } else {
        setProfileErrors({ form: "No se pudo guardar. Inténtalo de nuevo." });
      }
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSavePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordErrors({});
    setPasswordSaved(false);

    const errors: PasswordErrors = {};
    if (!currentPassword) errors.currentPassword = "Escribe tu contraseña actual.";
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      errors.password = "La contraseña debe tener al menos 8 caracteres.";
    }
    if (confirmPassword !== newPassword) {
      errors.confirmPassword = "Las contraseñas no coinciden.";
    }
    if (Object.keys(errors).length > 0) {
      setPasswordErrors(errors);
      return;
    }

    setSavingPassword(true);
    try {
      await api.updateMe({ currentPassword, password: newPassword });
      setPasswordSaved(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "INVALID_CREDENTIALS") {
          setPasswordErrors({ currentPassword: "Esa contraseña no es correcta." });
        } else {
          const fieldErrors = error.fieldErrors();
          const mapped: PasswordErrors = {
            currentPassword: fieldErrors.currentPassword,
            password: fieldErrors.password,
          };
          if (mapped.currentPassword || mapped.password) {
            setPasswordErrors(mapped);
          } else {
            setPasswordErrors({ form: "No se pudo cambiar la contraseña. Inténtalo de nuevo." });
          }
        }
      } else {
        setPasswordErrors({ form: "No se pudo cambiar la contraseña. Inténtalo de nuevo." });
      }
    } finally {
      setSavingPassword(false);
    }
  };

  const handleUnlink = async () => {
    if (!pendingUnlink) return;
    setUnlinking(true);
    setUnlinkError(null);
    try {
      await api.unlinkGuid(pendingUnlink);
      await refresh();
      setPendingUnlink(null);
    } catch (error) {
      setPendingUnlink(null);
      setUnlinkError(
        error instanceof ApiError && error.status === 404
          ? "Ese GUID ya no está vinculado a tu cuenta."
          : "No se pudo desvincular el GUID. Inténtalo de nuevo.",
      );
    } finally {
      setUnlinking(false);
    }
  };

  const linkedGuids = user.linkedGuids ?? [];
  const pendingInfo = linkedGuids.find((entry) => entry.guid === pendingUnlink);
  const nameDirty = displayName.trim() !== user.displayName && displayName.trim().length >= 3;

  return (
    <div>
      <h1 className="type-display-xl text-text">Mi cuenta</h1>
      <p className="type-caption mt-2 text-text-2">
        {user.email} · cuenta {user.role === "ADMIN" ? "ADMIN" : "de jugador"}
      </p>
      <div className="mb-6 mt-4 border-b border-border" aria-hidden="true" />

      <div className="space-y-4">
        <Panel title="Datos de la cuenta">
          <form onSubmit={handleSaveProfile} className="space-y-4" noValidate>
            {profileErrors.form && (
              <p role="alert" className="text-[13px] text-danger-hover">
                {profileErrors.form}
              </p>
            )}
            {profileSaved && <SavedLine>Cambios guardados.</SavedLine>}
            <div className="flex flex-col gap-1.5">
              <span className="type-label text-text-2">Email</span>
              <p className="type-body text-text">{user.email}</p>
            </div>
            <div className="max-w-[360px]">
              <Input
                label="Nombre de jugador"
                name="displayName"
                value={displayName}
                maxLength={32}
                onChange={(event) => setDisplayName(event.target.value)}
                error={profileErrors.displayName}
                autoComplete="nickname"
              />
            </div>
            <Button type="submit" size="sm" disabled={!nameDirty} loading={savingProfile}>
              {savingProfile ? "Guardando…" : "Guardar"}
            </Button>
          </form>
        </Panel>

        <Panel title="Cambiar contraseña">
          <form onSubmit={handleSavePassword} className="max-w-[360px] space-y-4" noValidate>
            {passwordErrors.form && (
              <p role="alert" className="text-[13px] text-danger-hover">
                {passwordErrors.form}
              </p>
            )}
            {passwordSaved && <SavedLine>Contraseña actualizada.</SavedLine>}
            <Input
              label="Contraseña actual"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              error={passwordErrors.currentPassword}
              passwordToggle
            />
            <Input
              label="Nueva contraseña"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              placeholder="Mínimo 8 caracteres"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              error={passwordErrors.password}
              passwordToggle
            />
            <Input
              label="Confirmar nueva contraseña"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              error={passwordErrors.confirmPassword}
              passwordToggle
            />
            <Button type="submit" size="sm" loading={savingPassword}>
              {savingPassword ? "Cambiando…" : "Cambiar contraseña"}
            </Button>
          </form>
        </Panel>

        <Panel title="GUIDs vinculados">
          {unlinkError && (
            <p role="alert" className="mb-3 text-[13px] text-danger-hover">
              {unlinkError}
            </p>
          )}

          {linkedGuids.length === 0 ? (
            <EmptyState
              icon={Link2}
              title="Sin GUIDs vinculados."
              description="La vinculación se hace desde el launcher de escritorio: abre el launcher, inicia sesión y dale JUGAR. La vinculación con tu GUID es automática al entrar al server, y tus partidas subirán a esta cuenta."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <caption className="sr-only">
                  GUIDs vinculados a tu cuenta con su última conexión conocida.
                </caption>
                <thead>
                  <tr className="bg-surface">
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">GUID</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Jugador</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left">
                      <span className="type-label text-text-2">Últ. conexión</span>
                    </th>
                    <th scope="col" className="hidden px-3 py-2.5 text-left md:table-cell">
                      <span className="type-label text-text-2">Últ. server</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right">
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {linkedGuids.map((entry) => (
                    <tr
                      key={entry.guid}
                      className="h-[44px] border-b border-border last:border-b-0 transition-colors duration-150 ease-out hover:bg-surface-2"
                    >
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <span className="type-mono text-text" title={entry.guid}>
                          {formatGuid(entry.guid)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {entry.name ? (
                          <Link
                            to={`/player/${entry.guid}`}
                            className="text-sm font-semibold text-text transition-colors duration-150 ease-out hover:text-accent"
                          >
                            {entry.name}
                          </Link>
                        ) : (
                          <span className="text-sm text-text-2">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <span className="type-caption text-text-2">
                          {entry.lastConnection ? formatRelative(entry.lastConnection) : "—"}
                        </span>
                      </td>
                      <td className="hidden px-3 py-2.5 md:table-cell">
                        <span className="type-mono text-text-2">{entry.lastServer ?? "—"}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingUnlink(entry.guid)}
                          className="text-danger-hover hover:text-danger-hover"
                        >
                          <Unlink size={14} strokeWidth={1.75} aria-hidden="true" />
                          Desvincular
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <ConfirmModal
        open={pendingUnlink !== null}
        title="¿Desvincular este GUID?"
        confirmLabel="Desvincular"
        loading={unlinking}
        onCancel={() => setPendingUnlink(null)}
        onConfirm={() => void handleUnlink()}
      >
        El GUID{" "}
        <span className="type-mono text-text">
          {pendingUnlink ? formatGuid(pendingUnlink) : ""}
        </span>{" "}
        {pendingInfo?.name ? `(${pendingInfo.name}) ` : ""}
        dejará de subir tus stats a tu cuenta. Podrás volver a vincularlo más tarde desde el
        launcher de escritorio.
      </ConfirmModal>
    </div>
  );
}
