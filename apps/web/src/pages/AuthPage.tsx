import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

export type AuthMode = "login" | "register";

interface FieldErrors {
  email?: string;
  password?: string;
  displayName?: string;
  confirmPassword?: string;
  rules?: string;
  form?: string;
}

const MIN_PASSWORD_LENGTH = 8;

function AuthLogo() {
  return (
    <div className="flex flex-col items-center gap-3">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2" y="2" width="16" height="16" fill="none" stroke="#8FD429" strokeWidth="3" />
      </svg>
      <span className="font-display text-[16px] font-bold uppercase leading-none tracking-[0.08em] text-text">
        Ranking IW4x
      </span>
    </div>
  );
}

function ModeToggle({ mode }: { mode: AuthMode }) {
  const optionClass = (active: boolean) =>
    `type-button flex h-8 items-center justify-center rounded-sm transition-colors duration-150 ease-out ${
      active ? "border border-accent-border bg-accent-subtle text-accent" : "text-text-2 hover:text-text"
    }`;
  return (
    <div className="grid grid-cols-2 gap-1 rounded-sm border border-border bg-surface-2 p-1" role="group" aria-label="Modo de acceso">
      <Link to="/login" className={optionClass(mode === "login")} aria-current={mode === "login" ? "page" : undefined}>
        Iniciar sesión
      </Link>
      <Link to="/register" className={optionClass(mode === "register")} aria-current={mode === "register" ? "page" : undefined}>
        Crear cuenta
      </Link>
    </div>
  );
}

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [registered, setRegistered] = useState(false);

  const from = (location.state as { from?: string } | null)?.from;

  // Ya autenticado (y sin registro recién completado): fuera de aquí.
  if (user && !registered) {
    return <Navigate to={from ?? "/"} replace />;
  }

  if (registered) {
    return (
      <div className="flex justify-center">
        <div className="my-12 w-full max-w-[400px] rounded-md border border-border bg-surface p-6 md:my-20">
          <div className="flex flex-col items-center gap-2 text-center">
            <CheckCircle2 size={32} strokeWidth={1.75} aria-hidden="true" className="text-accent" />
            <h1 className="type-display-l mt-2 text-text">Cuenta creada</h1>
            <p className="type-body mt-2 text-text-2">
              Ya puedes iniciar sesión. Para que tu progreso suba al ranking, abre el launcher,
              inicia sesión y dale JUGAR: la vinculación con tu GUID es automática al entrar al
              server.
            </p>
          </div>
          <div className="mt-6">
            <Link to="/account" className="block">
              <Button fullWidth>Ir a Mi cuenta</Button>
            </Link>
          </div>
          <div className="mt-2">
            <Link to="/" className="block">
              <Button variant="ghost" fullWidth>
                Ir al leaderboard
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!email.trim()) next.email = "Escribe tu email o usuario.";
    if (password.length < MIN_PASSWORD_LENGTH) {
      next.password = "La contraseña debe tener al menos 8 caracteres.";
    }
    if (mode === "register") {
      if (displayName.trim().length < 3 || displayName.trim().length > 32) {
        next.displayName = "El nombre debe tener entre 3 y 32 caracteres.";
      }
      if (confirmPassword !== password) {
        next.confirmPassword = "Las contraseñas no coinciden.";
      }
      if (!rulesAccepted) {
        next.rules = "Debes aceptar las normas de la comunidad.";
      }
    }
    return next;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validate();
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;

    setSubmitting(true);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
        navigate(from ?? "/", { replace: true });
      } else {
        await register({ email: email.trim(), password, displayName: displayName.trim() });
        setRegistered(true);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        const fieldErrors = error.fieldErrors();
        const next: FieldErrors = {};
        if (fieldErrors.email) next.email = fieldErrors.email;
        if (fieldErrors.password) next.password = fieldErrors.password;
        if (fieldErrors.displayName) next.displayName = fieldErrors.displayName;
        if (error.code === "INVALID_CREDENTIALS") {
          next.password = "Esa contraseña no es correcta.";
        }
        if (error.code === "EMAIL_TAKEN") {
          next.email = "Ese usuario ya está registrado.";
        }
        if (Object.keys(next).length === 0) {
          next.form = "Revisa los campos marcados.";
        }
        setErrors(next);
      } else {
        setErrors({ form: "Revisa los campos marcados." });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex justify-center">
      <div className="my-12 w-full max-w-[400px] rounded-md border border-border bg-surface p-6 md:my-20">
        <AuthLogo />

        <h1 className="type-display-l mt-6 text-center text-text">
          {mode === "login" ? "Entra al ranking" : "Únete al ranking"}
        </h1>

        <div className="mt-5">
          <ModeToggle mode={mode} />
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4" noValidate>
          {errors.form && (
            <p role="alert" className="text-[13px] text-danger-hover">
              {errors.form}
            </p>
          )}

          {mode === "register" && (
            <Input
              label="Nombre de jugador"
              name="displayName"
              autoComplete="nickname"
              placeholder="TuTagDelJuego"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              error={errors.displayName}
              maxLength={32}
            />
          )}

          <Input
            label="Email o usuario"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="tu@email.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={errors.email}
          />

          <Input
            label="Contraseña"
            name="password"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder="Mínimo 8 caracteres"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={errors.password}
            passwordToggle
          />

          {mode === "register" && (
            <>
              <Input
                label="Confirmar contraseña"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                placeholder="Repite la contraseña"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                error={errors.confirmPassword}
                passwordToggle
              />
              <div className="flex flex-col gap-1">
                <label className="flex items-start gap-2 text-[13px] text-text-2">
                  <input
                    type="checkbox"
                    checked={rulesAccepted}
                    onChange={(event) => setRulesAccepted(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-accent"
                  />
                  Acepto las normas de la comunidad
                </label>
                {errors.rules && (
                  <p role="alert" className="flex items-center gap-1.5 text-[13px] text-danger-hover">
                    {errors.rules}
                  </p>
                )}
              </div>
            </>
          )}

          <Button type="submit" fullWidth loading={submitting}>
            {submitting ? "Cargando…" : mode === "login" ? "Entrar" : "Crear cuenta"}
          </Button>
        </form>

        <div className="my-5 border-t border-border" aria-hidden="true" />

        <div className="text-center">
          <p className="text-[13px] text-text-2">¿Juegas en nuestros servers?</p>
          <p className="text-[13px] text-text-2">
            La vinculación de tu cuenta con tu GUID se hace desde el launcher de escritorio: inicia
            sesión y dale JUGAR.
          </p>
        </div>
      </div>
    </div>
  );
}
