import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setCsrfToken } from '../services/api';

export type SystemUserRole = 'admin' | 'operator';

export interface SystemUser {
  id: string;
  username: string;
  role: SystemUserRole;
}

interface AuthState {
  user: SystemUser | null;
  csrfToken: string | null;
}

interface AuthContextValue {
  user: SystemUser | null;
  csrfToken: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  refresh: () => Promise<void>;
  login: (input: { username: string; password: string; rememberMe: boolean }) => Promise<void>;
  register: (input: { username: string; password: string; inviteCode: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function normalizeAuthMePayload(payload: any): AuthState {
  const user = payload?.user ?? payload ?? null;
  const csrf = payload?.csrfToken ?? null;

  return {
    user: user && typeof user === 'object' ? (user as SystemUser) : null,
    csrfToken: typeof csrf === 'string' ? csrf : null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SystemUser | null>(null);
  const [csrfTokenState, setCsrfTokenState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const unauthorizedHandlerRef = useRef<((this: Window, ev: Event) => any) | null>(null);

  const applyState = (next: AuthState) => {
    setUser(next.user);
    setCsrfTokenState(next.csrfToken);
    setCsrfToken(next.csrfToken);
  };

  const refresh = async () => {
    const payload = await api.authMe();
    applyState(normalizeAuthMePayload(payload));
  };

  useEffect(() => {
    const run = async () => {
      try {
        await refresh();
      } catch {
        applyState({ user: null, csrfToken: null });
      } finally {
        setIsLoading(false);
      }
    };

    run();

    const handler = () => {
      applyState({ user: null, csrfToken: null });
    };

    unauthorizedHandlerRef.current = handler;
    window.addEventListener('auth:unauthorized', handler);

    return () => {
      if (unauthorizedHandlerRef.current) {
        window.removeEventListener('auth:unauthorized', unauthorizedHandlerRef.current);
      }
      unauthorizedHandlerRef.current = null;
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    return {
      user,
      csrfToken: csrfTokenState,
      isLoading,
      isAuthenticated: !!user,
      refresh,
      login: async ({ username, password, rememberMe }) => {
        await api.login(username, password, rememberMe);
        await refresh();
      },
      register: async ({ username, password, inviteCode }) => {
        await api.register(username, password, inviteCode);
        await refresh();
      },
      logout: async () => {
        try {
          await api.logout();
        } finally {
          applyState({ user: null, csrfToken: null });
        }
      },
    };
  }, [user, csrfTokenState, isLoading]);

  if (isLoading) {
    return null;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
