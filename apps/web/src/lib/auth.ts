import { ref, computed, type Ref, type ComputedRef } from 'vue';
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

const userRef = ref<User | null>(null);
const readyRef = ref<boolean>(false);
let bootstrapPromise: Promise<void> | null = null;

export function bootstrapAuth(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const token = getToken();
    if (!token) {
      readyRef.value = true;
      return;
    }
    try {
      const u = await api.get<User>('/auth/me');
      userRef.value = u;
    } catch {
      setToken(null);
      userRef.value = null;
    } finally {
      readyRef.value = true;
    }
  })();
  return bootstrapPromise;
}

export async function login(email: string, password: string): Promise<User> {
  const resp = await api.post<LoginResp>('/auth/login', { email, password });
  setToken(resp.token);
  userRef.value = resp.user;
  return resp.user;
}

export function logout(): void {
  setToken(null);
  userRef.value = null;
  bootstrapPromise = null;
  if (typeof window !== 'undefined') window.location.href = '/login';
}

export async function refresh(): Promise<void> {
  try {
    const u = await api.get<User>('/auth/me');
    userRef.value = u;
  } catch {
    setToken(null);
    userRef.value = null;
  }
}

export function useAuth(): {
  user: Ref<User | null>;
  isReady: Ref<boolean>;
  isAuthenticated: ComputedRef<boolean>;
  login: typeof login;
  logout: typeof logout;
  refresh: typeof refresh;
} {
  return {
    user: userRef,
    isReady: readyRef,
    isAuthenticated: computed(() => userRef.value !== null),
    login,
    logout,
    refresh,
  };
}

export function getCurrentUser(): User | null {
  return userRef.value;
}
