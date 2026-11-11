import { CREDITS_LINE, DESCRIPCION, ENGINE } from "../lib/meta";

/** Footer de créditos: línea oficial de marca (juego + engine) y descripción del proyecto. */
export function Footer() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-6 md:px-6">
        <p className="type-caption text-text-2">{CREDITS_LINE}</p>
        <p className="type-caption text-text-2">
          {DESCRIPCION} · {ENGINE}
        </p>
      </div>
    </footer>
  );
}
