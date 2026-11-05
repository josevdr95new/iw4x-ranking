import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { LeaderboardOrder, LeaderboardSort } from "../lib/api";

export interface SortableHeaderProps {
  label: string;
  field: LeaderboardSort;
  activeField: LeaderboardSort;
  activeOrder: LeaderboardOrder;
  onSort: (field: LeaderboardSort) => void;
}

/** Header de columna ordenable: <th><button> con icono de dirección. DESIGN.md §3.2. */
export function SortableHeader({
  label,
  field,
  activeField,
  activeOrder,
  onSort,
}: SortableHeaderProps) {
  const active = activeField === field;
  const Icon = !active ? ArrowUpDown : activeOrder === "asc" ? ArrowUp : ArrowDown;
  const nextOrder: LeaderboardOrder = active && activeOrder === "desc" ? "asc" : "desc";

  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      aria-label={`Ordenar por ${label.toLowerCase()}, ${nextOrder === "asc" ? "ascendente" : "descendente"}`}
      className={`type-label inline-flex items-center justify-end gap-1 transition-colors duration-150 ease-out hover:text-text ${
        active ? "text-accent" : "text-text-2"
      }`}
    >
      {label}
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
