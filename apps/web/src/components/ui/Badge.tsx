import type { ReactNode } from "react";

export type BadgeVariant = "success" | "warning" | "danger" | "neutral";

const variantClasses: Record<BadgeVariant, string> = {
  success: "bg-accent-subtle text-accent border border-accent-border",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger-hover",
  neutral: "bg-surface-2 text-text-2",
};

export function Badge({
  variant = "neutral",
  children,
  className = "",
}: {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex h-6 items-center gap-1 rounded-none px-2 text-[12px] font-medium leading-none tabular ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Badge de K/D con el umbral oficial de DESIGN.md §1.1. */
export function KdBadge({ value, className = "" }: { value: number; className?: string }) {
  let variant: BadgeVariant;
  if (value >= 1.2) variant = "success";
  else if (value >= 1) variant = "neutral";
  else if (value >= 0.8) variant = "warning";
  else variant = "danger";

  const neutralKd = variant === "neutral" ? "text-text" : "";
  return (
    <Badge variant={variant} className={className}>
      <span className={neutralKd}>
        {new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
          value,
        )}
      </span>
    </Badge>
  );
}
