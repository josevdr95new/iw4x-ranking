import { AlertCircle, Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  icon?: ReactNode;
  /** Muestra el botón ojo para alternar visibilidad (campos de contraseña). */
  passwordToggle?: boolean;
}

export function Input({
  label,
  error,
  icon,
  passwordToggle = false,
  className = "",
  id,
  type = "text",
  ...rest
}: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const [visible, setVisible] = useState(false);
  const resolvedType = passwordToggle ? (visible ? "text" : "password") : type;

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="type-label text-text-2">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-2">
            {icon}
          </span>
        )}
        <input
          id={inputId}
          type={resolvedType}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`h-10 w-full rounded-sm border bg-surface-2 px-3 text-text transition-colors duration-150 ease-out focus:border-accent focus:shadow-[0_0_0_1px_#8FD429] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
            icon ? "pl-9" : ""
          } ${passwordToggle ? "pr-10" : ""} ${error ? "border-danger" : "border-border"} ${className}`}
          {...rest}
        />
        {passwordToggle && (
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
            className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:text-text"
          >
            {visible ? (
              <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="flex items-center gap-1.5 text-[13px] text-danger-hover">
          <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}
