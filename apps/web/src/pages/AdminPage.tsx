import { useSearchParams } from "react-router-dom";
import { ServerConfigPanel } from "./admin/ServerConfigPanel";
import { ServerControlPanel } from "./admin/ServerControlPanel";
import { ModerationPanel } from "./admin/ModerationPanel";
import { IdentityPanel } from "./admin/IdentityPanel";

export type AdminTab = "config" | "identidad" | "moderacion";

const TABS: Array<{ id: AdminTab; label: string }> = [
  { id: "config", label: "Server config" },
  { id: "identidad", label: "Identidad" },
  { id: "moderacion", label: "Moderación" },
] as const;

function parseTab(raw: string | null): AdminTab {
  return raw === "identidad" || raw === "moderacion" ? raw : "config";
}

/** Shell de /admin: subnav de pestañas compartibles por URL (?tab=moderacion). */
export function AdminPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get("tab"));

  const setTab = (next: AdminTab) => {
    setSearchParams(
      (previous) => {
        const nextParams = new URLSearchParams(previous);
        if (next === "config") nextParams.delete("tab");
        else nextParams.set("tab", next);
        return nextParams;
      },
      { replace: true },
    );
  };

  return (
    <div>
      <h1 className="type-display-xl text-text">Administración</h1>
      <p className="type-caption mt-2 text-text-2">
        Config del server dedicado, identidad de la comunidad y moderación vía IW4MAdmin.
      </p>

      <div className="mb-4 mt-4 border-b border-border" aria-hidden="true" />

      <div role="tablist" aria-label="Secciones de administración" className="flex overflow-x-auto">
        {TABS.map((entry) => {
          const active = tab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`admin-tab-${entry.id}`}
              aria-selected={active}
              aria-controls={`admin-panel-${entry.id}`}
              onClick={() => setTab(entry.id)}
              className={`type-button flex h-10 items-center whitespace-nowrap rounded-sm px-4 transition-colors duration-150 ease-out ${
                active
                  ? "border border-accent-border bg-accent-subtle text-accent"
                  : "text-text-2 hover:text-text"
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      <div
        id={`admin-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`admin-tab-${tab}`}
        className="mt-4"
      >
        {tab === "config" ? (
          <>
            <ServerConfigPanel />
            {/* Control RCON en vivo: mapas, bots, exigir launcher (junto a Server config). */}
            <ServerControlPanel />
          </>
        ) : tab === "identidad" ? (
          <IdentityPanel />
        ) : (
          <ModerationPanel />
        )}
      </div>
    </div>
  );
}
