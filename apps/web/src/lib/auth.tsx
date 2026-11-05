import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { ApiError, api, getToken, setToken } from "./api";
import type { User } from "./api";

interface AuthState {
  user: User | null;
  /** true mientras se comprueba el token almacenado al arrancar. */
  initializing: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (input: { email: string; password: string; displayName: string }) => Promise<User>;
  logout: () => void;
  /** Relee /auth/me (p. ej. tras vincular el GUID). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState<boolean>(() => getToken() !== null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!getToken()) {
      setUser(null);
      return;
    }
    try {
      const { user: current } = await api.me();
      setUser(current);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setToken(null);
        setUser(null);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (!cancelled) setInitializing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string): Promise<User> => {
      const { user: loggedUser, token } = await api.login({ email, password });
      setToken(token);
      setUser(loggedUser);
      return loggedUser;
    },
    [],
  );

  const register = useCallback(
    async (input: { email: string; password: string; displayName: string }): Promise<User> => {
      const { user: newUser, token } = await api.register(input);
      setToken(token);
      setUser(newUser);
      return newUser;
    },
    [],
  );

  const logout = useCallback((): void => {
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, initializing, login, register, logout, refresh }),
    [user, initializing, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return ctx;
}
