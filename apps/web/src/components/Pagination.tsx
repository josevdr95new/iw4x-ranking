import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatInt } from "../lib/format";

export interface PaginationProps {
  page: number;
  totalPages: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPageChange: (page: number) => void;
}

/** Ventana de páginas con elipsis: 1 … 4 [5] 6 … 26 */
function pageWindow(page: number, totalPages: number): Array<number | "gap"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const wanted = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  const sorted = [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  let previous = 0;
  for (const p of sorted) {
    if (previous && p - previous > 1) out.push("gap");
    out.push(p);
    previous = p;
  }
  return out;
}

/** Paginación del leaderboard. DESIGN.md §3.2 y §4. */
export function Pagination({
  page,
  totalPages,
  rangeStart,
  rangeEnd,
  total,
  onPageChange,
}: PaginationProps) {
  if (totalPages <= 0) return null;

  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-border px-3 py-2 sm:flex-row">
      <p className="type-caption text-text-2" aria-live="polite">
        Mostrando {formatInt(rangeStart)}–{formatInt(rangeEnd)} de {formatInt(total)}
      </p>
      <nav aria-label="Paginación del ranking" className="flex items-center gap-1 p-1">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Página anterior"
          className="type-button flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {pageWindow(page, totalPages).map((entry, index) =>
          entry === "gap" ? (
            <span
              key={`gap-${index}`}
              aria-hidden="true"
              className="type-caption flex h-8 w-6 items-center justify-center text-text-2"
            >
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              onClick={() => onPageChange(entry)}
              aria-label={`Página ${entry}`}
              aria-current={entry === page ? "page" : undefined}
              className={`type-button flex h-8 min-w-8 items-center justify-center rounded-sm px-2 tabular transition-colors duration-150 ease-out ${
                entry === page
                  ? "border border-accent-border bg-accent-subtle text-accent"
                  : "border border-transparent text-text-2 hover:bg-surface-2 hover:text-text"
              }`}
            >
              {formatInt(entry)}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          aria-label="Página siguiente"
          className="type-button flex h-8 w-8 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </nav>
    </div>
  );
}
