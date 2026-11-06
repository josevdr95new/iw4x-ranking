import { LoaderCircle } from "lucide-react";
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active",
  ghost: "border border-border-strong text-text hover:bg-surface-2",
  danger: "bg-danger-fill text-white hover:bg-danger-fill-hover",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3",
  md: "h-10 px-4",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    fullWidth = false,
    className = "",
    disabled,
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={`type-button inline-flex items-center justify-center gap-2 rounded-sm transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40 ${variantClasses[variant]} ${sizeClasses[size]} ${fullWidth ? "w-full" : ""} ${className}`}
      {...rest}
    >
      {loading && (
        <LoaderCircle size={16} strokeWidth={1.75} aria-hidden="true" className="animate-spin" />
      )}
      {children}
    </button>
  );
});
