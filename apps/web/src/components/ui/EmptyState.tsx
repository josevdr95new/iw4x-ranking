import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}

/** Patrón único de estados vacíos y de error. DESIGN.md §4. */
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <Icon size={32} strokeWidth={1.75} aria-hidden="true" className="text-text-2" />
      <h3 className="type-display-m mt-2 text-text">{title}</h3>
      <p className="type-body max-w-sm text-text-2">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
