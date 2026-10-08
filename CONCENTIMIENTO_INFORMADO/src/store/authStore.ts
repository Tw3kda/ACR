import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createElement } from 'react';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';

import { apiConfig } from '@/services/api/config';
import { setAuthToken, setTokenRefreshHandler } from '@/services/apiClient';
import { base64ToBytes } from '@/services/base64';

/**
 * The professional's session on this tablet.
 *
 * It lasts exactly as long as the Cognito token (12 h, the token's own `exp`)
 * and survives closing the app: it is saved encrypted with expo-secure-store
 * (Android Keystore). When the token expires the app returns to the login
 * screen. There is no silent renewal and the refresh token is never stored —
 * a 30-day credential on a shared clinic device is exactly what should not be
 * lying around. Consents signed while offline or after expiry wait in the
 * outbox and are sent after the next login.
 */

const SESSION_KEY = 'acr.session';
/** How often to check for expiry while the app is open (timers sleep with the tablet). */
const EXPIRY_CHECK_INTERVAL_MS = 60 * 1000;

export type AuthUser = {
  id: string;
  email: string;
  name: string;
};

type StoredSession = { token: string; user: AuthUser; expiresAt: number };

export type AuthState = {
  token: string | null;
  user: AuthUser | null;
  /** True while the saved session is being restored at startup. */
  isLoading: boolean;
  /** When the session ends (epoch ms), or null when logged out. */
  expiresAt: number | null;
  login: (token: string, user: AuthUser, refreshToken?: string | null) => void;
  logout: () => void;
};

export const AuthContext = createContext<AuthState | undefined>(undefined);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

/** The token's `exp` in ms. Cognito issued it; only the time is read here. */
function tokenExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = base64ToBytes(part);
    let json = '';
    for (let i = 0; i < bytes.length; i += 1) json += String.fromCharCode(bytes[i]);
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// SecureStore has no web implementation; `expo start --web` is only for
// development, so there the session goes to localStorage.
async function readStored(): Promise<StoredSession | null> {
  try {
    const raw =
      Platform.OS === 'web' ? globalThis.localStorage?.getItem(SESSION_KEY) : await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed?.token && parsed.expiresAt > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStored(session: StoredSession | null): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (session) globalThis.localStorage?.setItem(SESSION_KEY, JSON.stringify(session));
      else globalThis.localStorage?.removeItem(SESSION_KEY);
      return;
    }
    if (session) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
    else await SecureStore.deleteItemAsync(SESSION_KEY);
  } catch (error) {
    console.warn('[AUTH] no se pudo guardar la sesión:', error instanceof Error ? error.message : error);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Read by timers and the API client's 401 handler, outside React's render.
  const expiresAtRef = useRef<number | null>(null);

  // Restore the saved session once, at startup.
  useEffect(() => {
    let cancelled = false;
    readStored().then((stored) => {
      if (cancelled) return;
      if (stored) {
        expiresAtRef.current = stored.expiresAt;
        setSession(stored);
      } else {
        void writeStored(null); // an expired leftover is removed
      }
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setAuthToken(session?.token ?? null);
  }, [session]);

  const logout = useCallback(() => {
    expiresAtRef.current = null;
    setSession(null);
    void writeStored(null);
  }, []);

  const login = useCallback((nextToken: string, nextUser: AuthUser) => {
    // The refresh token the API returns is ignored on purpose (see above).
    const expiresAt =
      tokenExpiry(nextToken) ?? Date.now() + apiConfig.auth.tokenTtlHours * 60 * 60 * 1000;
    const next = { token: nextToken, user: nextUser, expiresAt };
    expiresAtRef.current = expiresAt;
    setSession(next);
    void writeStored(next);
  }, []);

  // A 401 means the token is no longer accepted (expired or revoked): back to login.
  useEffect(() => {
    setTokenRefreshHandler(async () => {
      logout();
      return null;
    });
    return () => setTokenRefreshHandler(null);
  }, [logout]);

  // End the session at expiry, also after the tablet wakes up.
  useEffect(() => {
    if (!session) return;
    const checkExpiry = () => {
      const expiresAt = expiresAtRef.current;
      if (expiresAt !== null && Date.now() >= expiresAt) logout();
    };
    const timer = setTimeout(checkExpiry, Math.max(0, session.expiresAt - Date.now()) + 1000);
    const interval = setInterval(checkExpiry, EXPIRY_CHECK_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkExpiry();
    });
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      subscription.remove();
    };
  }, [session, logout]);

  const value = useMemo<AuthState>(
    () => ({
      token: session?.token ?? null,
      user: session?.user ?? null,
      isLoading,
      expiresAt: session?.expiresAt ?? null,
      login,
      logout,
    }),
    [session, isLoading, login, logout]
  );

  return createElement(AuthContext.Provider, { value }, children);
}
