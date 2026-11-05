import { ArrowRight, Check, Copy, LogIn, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../lib/api";
import type { LinkCandidate } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { formatRelative } from "../lib/format";

type Step = 1 | 2 | 3 | 4;
type DetectState = "scanning" | "empty" | "error";

const STEP_LABELS = ["Instrucciones", "Detección", "Tu GUID", "Listo"] as const;

/** IP placeholder del wireframe (§3.5): la lista de servidores aún no existe en la API. */
const COMMUNITY_SERVER = "cl.example.net:28960";

function Stepper({ step }: { step: Step }) {
  return (
    <ol className="flex items-center" aria-label="Progreso de la vinculación">
      {STEP_LABELS.map((label, index) => {
        const position = (index + 1) as Step;
        const completed = position < step;
        const active = position === step;
        return (
          <li key={label} className="flex items-center">
            <span className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
              <span
                aria-hidden="true"
                className={`flex h-7 w-7 items-center justify-center rounded-full border text-[12px] font-semibold tabular ${
                  completed
                    ? "border-accent bg-accent text-on-accent"
                    : active
                      ? "border-accent-border bg-accent-subtle text-accent"
                      : "border-border bg-surface text-text-2"
                }`}
              >
                {completed ? <Check size={14} strokeWidth={1.75} /> : position}
              </span>
              <span
                className={`type-label hidden md:inline ${active ? "text-text" : "text-text-2"}`}
              >
                {label}
              </span>
            </span>
            {position < STEP_LABELS.length && (
              <span
                aria-hidden="true"
                className={`mx-2 h-px w-6 md:w-10 ${completed ? "bg-accent-border" : "bg-border"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepPanel({
  stepNumber,
  title,
  children,
  footer,
}: {
  stepNumber: Step;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <span className="type-label text-text-2">Paso {stepNumber} de 4</span>
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        <h2 className="type-display-m text-text">{title}</h2>
      </header>
      <div className="p-5">{children}</div>
      {footer && (
        <footer className="flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:justify-end">
          {footer}
        </footer>
      )}
    </section>
  );
}

export function LinkPage() {
  const { user, initializing, refresh } = useAuth();
  const [step, setStep] = useState<Step>(1);
  const [detect, setDetect] = useState<DetectState>("scanning");
  const [candidates, setCandidates] = useState<LinkCandidate[]>([]);
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [linkedName, setLinkedName] = useState<string | null>(null);
  const [linkedGuid, setLinkedGuid] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

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
          icon={LogIn}
          title="Necesitas una cuenta."
          description="Inicia sesión para vincular tu jugador del juego con tu perfil web."
          action={
            <Link to="/login" state={{ from: "/link" }}>
              <Button>Entrar</Button>
            </Link>
          }
        />
      </div>
    );
  }

  if (user.linkedGuid && step === 1) {
    return (
      <div className="rounded-md border border-border bg-surface">
        <EmptyState
          icon={ShieldAlert}
          title="Tu cuenta ya está vinculada."
          description={`Tu cuenta está asociada al jugador con GUID ${user.linkedGuid}. Si no reconoces esta vinculación, contacta con un administrador.`}
          action={
            <Link to={`/player/${user.linkedGuid}`}>
              <Button variant="ghost">Ver mi perfil</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const copyServer = async () => {
    try {
      await navigator.clipboard.writeText(COMMUNITY_SERVER);
    } catch {
      // Portapapeles no disponible: sin feedback de copia.
      return;
    }
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const detectCandidates = async () => {
    setStep(2);
    setDetect("scanning");
    setConfirmError(null);
    setSelectedGuid(null);
    try {
      await api.linkStart();
      const response = await api.linkCandidates();
      if (response.candidates.length > 0) {
        setCandidates(response.candidates);
        setStep(3);
      } else {
        setCandidates([]);
        setDetect("empty");
      }
    } catch {
      setDetect("error");
    }
  };

  const confirmCandidate = async () => {
    if (!selectedGuid) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const response = await api.linkConfirm(selectedGuid);
      setLinkedName(response.name);
      setLinkedGuid(response.guid);
      setStep(4);
      await refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "USER_ALREADY_LINKED") {
          setConfirmError("Tu cuenta ya tiene un jugador vinculado.");
          await refresh();
        } else if (error.code === "GUID_ALREADY_LINKED") {
          setConfirmError("Ese jugador ya pertenece a otra cuenta.");
        } else if (error.code === "PLAYER_NOT_FOUND") {
          setStep(2);
          setDetect("empty");
        } else {
          setConfirmError("No pudimos confirmar la vinculación. Inténtalo de nuevo.");
        }
      } else {
        setConfirmError("No pudimos confirmar la vinculación. Inténtalo de nuevo.");
      }
    } finally {
      setConfirming(false);
    }
  };

  const detectionAnnouncement =
    step === 2 && detect === "scanning"
      ? "Escaneando jugadores conectados…"
      : step === 2 && detect === "empty"
        ? "No encontramos ninguna cuenta nueva en los servidores."
        : step === 3
          ? `Encontramos ${candidates.length} jugadores conectados recientemente.`
          : "";

  return (
    <div>
      <h1 className="type-display-xl text-text">Vincula tu cuenta de juego</h1>
      <p className="type-body-lg mt-2 text-text-2">
        4 pasos, 2 minutos. Tu progreso del server aparece en el ranking.
      </p>

      <div className="mb-6 mt-8">
        <Stepper step={step} />
      </div>

      <p aria-live="polite" className="sr-only">
        {detectionAnnouncement}
      </p>

      {step === 1 && (
        <StepPanel
          stepNumber={1}
          title="Únete a un servidor"
          footer={
            <Button onClick={() => void detectCandidates()}>
              Detectar mi cuenta
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          }
        >
          <ol className="type-body-lg list-decimal space-y-3 pl-5 text-text">
            <li>
              Abre IW4x y entra a cualquier servidor de la comunidad:
              <span className="mt-2 flex flex-wrap items-center gap-3">
                <span className="type-mono inline-flex h-10 items-center rounded-sm border border-border bg-surface-2 px-3 text-text">
                  {COMMUNITY_SERVER}
                </span>
                <Button variant="ghost" size="sm" onClick={() => void copyServer()}>
                  {copied ? (
                    <>
                      <Check size={16} strokeWidth={1.75} aria-hidden="true" className="text-accent" />
                      Copiada
                    </>
                  ) : (
                    <>
                      <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
                      Copiar
                    </>
                  )}
                </Button>
              </span>
            </li>
            <li>Juega al menos una ronda (30 segundos bastan).</li>
            <li>Vuelve a esta pestaña sin cerrar el juego.</li>
          </ol>
        </StepPanel>
      )}

      {step === 2 && (
        <StepPanel stepNumber={2} title="Buscando en los servidores">
          {detect === "scanning" && (
            <p className="type-body-lg flex items-center gap-3 text-text">
              <Spinner size={20} />
              Escaneando jugadores conectados…
            </p>
          )}
          {detect === "empty" && (
            <div className="flex flex-col items-start gap-4">
              <p className="type-body-lg text-text">
                No encontramos ninguna cuenta nueva en los servidores.
              </p>
              <p className="type-body text-text-2">
                Comprueba que estás dentro de una partida y vuelve a intentarlo en unos segundos.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void detectCandidates()}>Reintentar</Button>
                <Button variant="ghost" onClick={() => setStep(1)}>
                  Volver
                </Button>
              </div>
            </div>
          )}
          {detect === "error" && (
            <div className="flex flex-col items-start gap-4">
              <p className="type-body-lg text-text">
                No pudimos consultar los servidores en este momento.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void detectCandidates()}>Reintentar</Button>
                <Button variant="ghost" onClick={() => setStep(1)}>
                  Volver
                </Button>
              </div>
            </div>
          )}
        </StepPanel>
      )}

      {step === 3 && (
        <StepPanel
          stepNumber={3}
          title="Elige tu jugador"
          footer={
            <>
              {confirmError && (
                <p role="alert" className="mr-auto self-center text-[13px] text-danger-hover">
                  {confirmError}
                </p>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setStep(1);
                  setConfirmError(null);
                }}
              >
                Volver
              </Button>
              <Button onClick={() => void confirmCandidate()} disabled={selectedGuid === null} loading={confirming}>
                {confirming ? "Confirmando…" : "Confirmar jugador"}
                {!confirming && <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />}
              </Button>
            </>
          }
        >
          <p className="type-body-lg text-text">
            Encontramos estos jugadores conectados recientemente:
          </p>
          <div
            role="radiogroup"
            aria-label="Jugadores detectados"
            className="mt-4 flex flex-col gap-2"
          >
            {candidates.map((candidate) => {
              const selected = candidate.guid === selectedGuid;
              return (
                <label
                  key={candidate.guid}
                  className={`flex h-14 cursor-pointer items-center gap-3 rounded-sm border px-3 transition-colors duration-150 ease-out ${
                    selected
                      ? "border-accent-border bg-accent-subtle"
                      : "border-border hover:bg-surface-2"
                  }`}
                >
                  <input
                    type="radio"
                    name="link-candidate"
                    value={candidate.guid}
                    checked={selected}
                    onChange={() => setSelectedGuid(candidate.guid)}
                    className="h-4 w-4 shrink-0 accent-accent"
                    aria-label={`Jugador ${candidate.name}, GUID ${candidate.guid}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-text">
                      {candidate.name}
                    </span>
                    {candidate.server && (
                      <span className="type-mono mt-0.5 block truncate text-[11px] text-text-2">
                        {candidate.server}
                      </span>
                    )}
                  </span>
                  <span className="type-mono hidden shrink-0 text-text-2 sm:inline">
                    GUID {candidate.guid.slice(0, 12)}…
                  </span>
                  <span className="type-caption shrink-0 text-text-2">
                    {formatRelative(candidate.lastConnection)}
                  </span>
                </label>
              );
            })}
          </div>
        </StepPanel>
      )}

      {step === 4 && (
        <StepPanel stepNumber={4} title="Todo listo">
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Check
              size={40}
              strokeWidth={1.75}
              aria-hidden="true"
              className="check-draw text-accent"
            />
            <p className="type-body-lg text-text">
              <span className="font-semibold">{linkedName ?? "Tu jugador"}</span> quedó vinculado a
              tu cuenta.
            </p>
            <p className="type-body text-text-2">Ya apareces en el ranking de la comunidad.</p>
            {linkedGuid && (
              <Link to={`/player/${linkedGuid}`} className="mt-3">
                <Button>Ver mi perfil</Button>
              </Link>
            )}
          </div>
        </StepPanel>
      )}
    </div>
  );
}
