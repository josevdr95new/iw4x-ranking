import { useSearchParams } from "react-router-dom";
import { ServerConfigPanel } from "./admin/ServerConfigPanel";
import { ModerationPanel } from "./admin/ModerationPanel";

export type AdminTab = "config" | "moderacion";

const TABS: Array<{ id: AdminTab; label: string }> = [
  { id: "config", label: "Server config" },
  { id: "moderacion", label: "Moderación" },
] as const;

/** Shell de /admin: subnav de dos pestañas; ?tab=moderacion es compartible por URL. */
export function AdminPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: AdminTab = searchParams.get("tab") === "moderacion" ? "moderacion" : "config";

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
        Config del server dedicado y moderación de la comunidad vía IW4MAdmin.
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
        {tab === "config" ? <ServerConfigPanel /> : <ModerationPanel />}
      </div>
    </div>
  );
}
