import { useEffect } from "react";

/**
 * Fuente única de marca de la web, alineada con CTHLG.pro (raíz del repo).
 * Cualquier texto de marca visible en la UI debe salir de aquí.
 */

/** Nombre oficial del proyecto. */
export const PRO_NAME = "CTHLG MW2 Ranking";

/** Marca corta oficial. */
export const PRO_SHORT = "CTHLG";

/** Marca visible compuesta (header, login, titles): proyecto + juego. */
export const BRAND_DISPLAY = "CTHLG MW2 RANKING";

/** Versión oficial (igual que CTHLG.pro). */
export const VERSION = "0.1.5";

/** Año de copyright. */
export const ANIO = 2026;

/** Juego oficial del ranking. */
export const JUEGO = "Call of Duty: Modern Warfare 2 (2009)";

/** Engine/mod oficial del server. */
export const ENGINE = "IW4x — AlterWare r5318";

/** Autores oficiales. */
export const AUTORES = "José Domínguez Ramírez · Rafael Font Rojas";

/** Autoría oficial (formato CTHLG.pro). */
export const AUTOR = `Desarrollado por ${AUTORES}`;

/** Descripción oficial del proyecto. */
export const DESCRIPCION = `Sistema de ranking, ELO y cloud-save para ${JUEGO} — CTHolguin`;

/** Línea de créditos del footer. */
export const CREDITS_LINE = `${BRAND_DISPLAY} v${VERSION} · ${JUEGO} · IW4x · ${ANIO} · ${AUTORES}`;

/** Título de documento con prefijo de marca: "CTHLG MW2 RANKING — Sección". */
export function documentTitle(section?: string): string {
  return section ? `${BRAND_DISPLAY} — ${section}` : BRAND_DISPLAY;
}

/** Fija el título del documento por página, siempre con la marca como prefijo. */
export function useDocumentTitle(section?: string): void {
  useEffect(() => {
    document.title = documentTitle(section);
  }, [section]);
}
