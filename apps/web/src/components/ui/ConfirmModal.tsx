import { AlertCircle, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "./Button";

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Modal de confirmación (§1.5: z-50, shadow-modal, rounded-lg). Esc cierra. */
export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[rgba(11,12,9,0.7)]"
        onClick={onCancel}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        className="relative w-full max-w-[420px] rounded-lg border border-border bg-surface p-5 shadow-modal"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="confirm-modal-title" className="type-display-m text-text">
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cerrar"
            className="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <div className="type-body mt-3 flex items-start gap-2 text-text-2">
          <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
          <div>{children}</div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Volver
          </Button>
          <Button variant="danger" ref={confirmRef} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
