import { useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken } from './api';

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  name?: string;
  settings?: Record<string, unknown>;
  createdAt?: string;
}

interface LoginResp {
  token: string;
  user: User;
}

let cachedUser: User | null = null;
const subscribers = new Set<(u: User | null) => void>();

function notify(u: User | null): void {
  cachedUser = u;
  subscribers.forEach((fn) => fn(u));
}

export function useAuth(): {
  user: User | null;
  isReady: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => void;
  refresh: () => Promise<void>;
} {
  const [user, setUser] = useState<User | null>(cachedUser);
  const [isReady, setReady] = useState<boolean>(cachedUser !== null);

  useEffect(() => {
    const sub = (u: User | null): void => setUser(u);
    subscribers.add(sub);
    return () => {
      subscribers.delete(sub);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) {
      setReady(true);
      return;
    }
    if (cachedUser) {
      setReady(true);
      return;
    }
    api
      .get<User>('/auth/me')
      .then((u) => {
        if (cancelled) return;
        notify(u);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setToken(null);
        notify(null);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<User> => {
    const resp = await api.post<LoginResp>('/auth/login', { email, password });
    setToken(resp.token);
    notify(resp.user);
    return resp.user;
  }, []);

  const logout = useCallback((): void => {
    setToken(null);
    notify(null);
    if (typeof window !== 'undefined') window.location.href = '/login';
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const u = await api.get<User>('/auth/me');
      notify(u);
    } catch {
      setToken(null);
      notify(null);
    }
  }, []);

  return { user, isReady, login, logout, refresh };
}

export function getCurrentUser(): User | null {
  return cachedUser;
}
