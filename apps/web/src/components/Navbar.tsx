import { ChevronDown, Link2, LogOut, Menu, Settings, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { initialsOf } from "../lib/format";

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label="Ranking IW4x, inicio">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2" y="2" width="16" height="16" fill="none" stroke="#8FD429" strokeWidth="3" />
      </svg>
      <span className="font-display text-[16px] font-bold uppercase leading-none tracking-[0.08em] text-text">
        Ranking IW4x
      </span>
    </Link>
  );
}

const navLinkClass = (active: boolean) =>
  `type-button relative flex h-14 items-center transition-colors duration-150 ease-out ${
    active
      ? "text-text after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-accent"
      : "text-text-2 hover:text-text"
  }`;

export function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen && !dropdownOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setDropdownOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen, dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const onClick = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [dropdownOpen]);

  const handleLogout = () => {
    setDropdownOpen(false);
    logout();
    navigate("/");
  };

  const profileHref = user?.linkedGuid ? `/player/${user.linkedGuid}` : "/link";

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 md:px-6">
        <Logo />

        <nav aria-label="Navegación principal" className="hidden h-full items-center gap-6 md:flex">
          <NavLink to="/" end className={({ isActive }) => navLinkClass(isActive)}>
            Leaderboard
          </NavLink>
          {user?.linkedGuid && (
            <NavLink
              to={`/player/${user.linkedGuid}`}
              className={({ isActive }) => navLinkClass(isActive)}
            >
              Perfil
            </NavLink>
          )}
          <NavLink to="/link" className={({ isActive }) => navLinkClass(isActive)}>
            Vincular cuenta
          </NavLink>
          {user?.role === "ADMIN" && (
            <NavLink to="/admin" className={({ isActive }) => navLinkClass(isActive)}>
              Admin
            </NavLink>
          )}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {user ? (
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setDropdownOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={dropdownOpen}
                aria-label="Menú de cuenta"
                className="flex h-9 items-center gap-2 rounded-sm px-1 transition-colors duration-150 ease-out hover:bg-surface-2"
              >
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 items-center justify-center rounded-sm border border-accent-border bg-accent-subtle font-display text-[12px] font-bold tracking-[0.04em] text-accent"
                >
                  {initialsOf(user.displayName)}
                </span>
                <span className="hidden text-sm font-medium text-text sm:inline">
                  {user.displayName}
                </span>
                <ChevronDown
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className={`text-text-2 transition-transform duration-150 ${dropdownOpen ? "rotate-180" : ""}`}
                />
              </button>
              {dropdownOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-40 mt-2 w-48 rounded-lg border border-border bg-surface-2 p-1 shadow-panel"
                >
                  <Link
                    role="menuitem"
                    to={profileHref}
                    onClick={() => setDropdownOpen(false)}
                    className="flex h-9 items-center gap-2 rounded-sm px-3 text-sm text-text transition-colors duration-150 ease-out hover:bg-surface"
                  >
                    <User size={16} strokeWidth={1.75} aria-hidden="true" />
                    Mi perfil
                  </Link>
                  <Link
                    role="menuitem"
                    to="/account"
                    onClick={() => setDropdownOpen(false)}
                    className="flex h-9 items-center gap-2 rounded-sm px-3 text-sm text-text transition-colors duration-150 ease-out hover:bg-surface"
                  >
                    <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
                    Mi cuenta
                  </Link>
                  <Link
                    role="menuitem"
                    to="/link"
                    onClick={() => setDropdownOpen(false)}
                    className="flex h-9 items-center gap-2 rounded-sm px-3 text-sm text-text transition-colors duration-150 ease-out hover:bg-surface"
                  >
                    <Link2 size={16} strokeWidth={1.75} aria-hidden="true" />
                    Vincular cuenta
                  </Link>
                  <div className="my-1 border-t border-border" aria-hidden="true" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleLogout}
                    className="flex h-9 w-full items-center gap-2 rounded-sm px-3 text-left text-sm text-danger-hover transition-colors duration-150 ease-out hover:bg-surface"
                  >
                    <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
                    Cerrar sesión
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Link
              to="/login"
              className="type-button inline-flex h-9 items-center rounded-sm bg-accent px-4 text-on-accent transition-colors duration-150 ease-out hover:bg-accent-hover active:bg-accent-active"
            >
              Entrar
            </Link>
          )}

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? "Cerrar menú" : "Abrir menú"}
            aria-expanded={menuOpen}
            className="flex h-11 w-11 items-center justify-center rounded-sm text-text-2 transition-colors duration-150 ease-out hover:text-text md:hidden"
          >
            {menuOpen ? (
              <X size={20} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav
          aria-label="Navegación móvil"
          className="border-t border-border bg-surface md:hidden"
        >
          <NavLink
            to="/"
            end
            onClick={() => setMenuOpen(false)}
            className={({ isActive }) =>
              `type-button flex h-12 items-center border-b border-border px-4 transition-colors duration-150 ease-out ${
                isActive ? "text-text" : "text-text-2"
              }`
            }
          >
            Leaderboard
          </NavLink>
          {user?.linkedGuid && (
            <NavLink
              to={`/player/${user.linkedGuid}`}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `type-button flex h-12 items-center border-b border-border px-4 transition-colors duration-150 ease-out ${
                  isActive ? "text-text" : "text-text-2"
                }`
              }
            >
              Perfil
            </NavLink>
          )}
          <NavLink
            to="/link"
            onClick={() => setMenuOpen(false)}
            className={({ isActive }) =>
              `type-button flex h-12 items-center border-b border-border px-4 transition-colors duration-150 ease-out ${
                isActive ? "text-text" : "text-text-2"
              }`
            }
          >
            Vincular cuenta
          </NavLink>
          {user?.role === "ADMIN" && (
            <NavLink
              to="/admin"
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `type-button flex h-12 items-center border-b border-border px-4 transition-colors duration-150 ease-out ${
                  isActive ? "text-text" : "text-text-2"
                }`
              }
            >
              Admin
            </NavLink>
          )}
          {!user && (
            <Link
              to="/login"
              onClick={() => setMenuOpen(false)}
              className="type-button flex h-12 items-center border-b border-border px-4 text-accent"
            >
              Entrar
            </Link>
          )}
        </nav>
      )}
    </header>
  );
}
