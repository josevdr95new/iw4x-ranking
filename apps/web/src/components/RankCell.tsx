import { Medal } from "lucide-react";
import { formatInt } from "../lib/format";

const medalColors: Record<1 | 2 | 3, string> = {
  1: "text-medal-gold",
  2: "text-medal-silver",
  3: "text-medal-bronze",
};

/** Celda de rank del leaderboard. Top 3 con medalla lucide; solo celda #. §3.2. */
export function RankCell({ rank }: { rank: number }) {
  if (rank >= 1 && rank <= 3) {
    const color = medalColors[rank as 1 | 2 | 3];
    return (
      <span className="flex items-center gap-1.5">
        <Medal size={16} strokeWidth={1.75} aria-hidden="true" className={color} />
        <span className={`text-sm font-semibold tabular ${color}`}>{formatInt(rank)}</span>
      </span>
    );
  }
  return (
    <span className="text-sm font-medium tabular text-text-2">{formatInt(rank)}</span>
  );
}
