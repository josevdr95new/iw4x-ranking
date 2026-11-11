import { Spinner } from "./Spinner";

/**
 * Franja de estado "en espera" (HUD, no alert): comando enviado y verificando
 * con el server. Visible todo el tiempo que dure la request (puede tardar
 * ~45s un map/rotate y hasta ~2 min un reinicio con verificación real).
 */
export function WaitingStrip({ text }: { text: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 rounded-md border border-border-strong bg-surface-2 px-4 py-3 text-sm"
    >
      <Spinner size={16} />
      <p className="type-caption text-text-2">{text}</p>
    </div>
  );
}
