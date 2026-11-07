import type { ReactNode } from "react";

/** Panel estándar de administración: surface + hairline, header con título/caption y acción opcional. */
export function Panel({
  title,
  caption,
  action,
  children,
}: {
  title: string;
  caption?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <div>
          <h2 className="type-display-m text-text">{title}</h2>
          {caption && <p className="type-caption mt-0.5 text-text-2">{caption}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
