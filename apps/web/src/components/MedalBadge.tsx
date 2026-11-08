import type { PlayerMedal } from "../lib/api";
import { formatInt } from "../lib/format";

export type MedalSize = "sm" | "md" | "lg";

/**
 * Medalla ELO. Dominio de color propio (contrato medallas): estrella llena ámbar
 * `medal-star`, vacía dim `medal-star-off`, LEYENDA en `medal-leyenda`. Igual que
 * medal-gold/silver/bronze, estos colores NO se usan fuera de este componente (DESIGN.md §1.1).
 */
const MEDAL_SIZES: Record<
  MedalSize,
  { image: string; stars: string; tier: string; name: string; tag: string; gap: string }
> = {
  sm: {
    image: "h-7 w-7",
    stars: "text-[11px] tracking-[0.12em]",
    tier: "text-[12px]",
    name: "text-[11px]",
    tag: "h-[14px] px-1 text-[9px]",
    gap: "gap-2",
  },
  md: {
    image: "h-10 w-10",
    stars: "text-[13px] tracking-[0.15em]",
    tier: "text-[14px]",
    name: "text-[12px]",
    tag: "h-4 px-1.5 text-[10px]",
    gap: "gap-2.5",
  },
  lg: {
    image: "h-14 w-14",
    stars: "text-[18px] tracking-[0.18em]",
    tier: "text-[16px]",
    name: "text-[13px]",
    tag: "h-[18px] px-1.5 text-[10px]",
    gap: "gap-3",
  },
};

/** Sanitiza el assetId del contrato a un nombre de archivo seguro (/medals/*.png). */
function medalAssetSrc(assetId: string): string | null {
  const safe = assetId.replace(/[^a-z0-9-]/gi, "").toLowerCase();
  return safe ? `/medals/${safe}.png` : null;
}

/** "ELO 1.442" con entero redondeado (formato es-ES como el resto del sitio). */
function formatElo(elo: number | null | undefined): string | null {
  if (elo === null || elo === undefined) return null;
  return formatInt(Math.round(elo));
}

export function MedalBadge({
  medal,
  size = "sm",
  elo = null,
  showName = false,
  className = "",
}: {
  medal: PlayerMedal | null | undefined;
  size?: MedalSize;
  /** Skill/ELO actual del jugador: tooltip y aria-label ("RECLUTA III — ELO 1234"). */
  elo?: number | null;
  /** Pinta el nombre del tier dentro del badge (perfil, lg). En tier 8 el nombre ya va en "LEYENDA #N". */
  showName?: boolean;
  className?: string;
}) {
  if (!medal) return null;

  const s = MEDAL_SIZES[size];
  const isLegend = medal.tierId === 8;
  const tierName = medal.name || "—";
  const src = medalAssetSrc(medal.assetId ?? "");
  const eloText = formatElo(elo);
  const legendRank =
    isLegend && medal.globalRank !== null && medal.globalRank !== undefined
      ? formatInt(medal.globalRank)
      : null;

  // Tooltip estilo contrato: "RECLUTA III — ELO 1234" / "LEYENDA #2 — ELO 1899 · TOP 12".
  const titleParts = [isLegend && legendRank ? `${tierName} #${legendRank}` : tierName];
  if (eloText) titleParts.push(`ELO ${eloText}`);
  if (medal.eliteTop12) titleParts.push("TOP 12");
  const title = titleParts.join(" — ");

  const ariaLabel = `Medalla ${title}`;
  const filled = Math.max(0, Math.min(5, Math.round(medal.stars ?? 0)));

  return (
    <span role="img" aria-label={ariaLabel} title={title} className={`inline-flex items-center ${s.gap} ${className}`}>
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className={`${s.image} shrink-0 select-none ${
            medal.eliteTop12
              ? "rounded-full border border-medal-star bg-medal-star/5 p-[2px]"
              : ""
          }`}
        />
      ) : (
        // Shape inesperado sin assetId: cuadro dim que conserva el layout.
        <span aria-hidden="true" className={`${s.image} shrink-0 rounded-sm border border-border bg-surface-2`} />
      )}

      <span className="flex min-w-0 flex-col items-start gap-0.5">
        {!isLegend && showName && (
          <span className={`type-label leading-none text-text ${s.name}`}>{tierName}</span>
        )}

        {!isLegend && (
          <span aria-hidden="true" className={`leading-none ${s.stars}`}>
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index} className={index < filled ? "text-medal-star" : "text-medal-star-off"}>
                ★
              </span>
            ))}
          </span>
        )}
        {!isLegend && <span className="sr-only">{filled} de 5 estrellas</span>}

        {isLegend && (
          <span
            className={`font-display font-semibold uppercase leading-none tracking-[0.08em] text-medal-leyenda ${s.tier}`}
          >
            {legendRank ? `LEYENDA #${legendRank}` : "LEYENDA"}
          </span>
        )}

        {medal.eliteTop12 && (
          <span
            className={`type-mono inline-flex items-center rounded-none border border-medal-star/60 bg-medal-star/10 leading-none text-medal-star ${s.tag}`}
          >
            TOP 12
          </span>
        )}
      </span>
    </span>
  );
}
