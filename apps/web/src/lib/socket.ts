import { io, type Socket } from 'socket.io-client';
import { onBeforeUnmount, onMounted } from 'vue';
import { getToken } from './api';

let socket: Socket | null = null;

/**
 * Resolve the Socket.IO target URL. In dev we deliberately bypass the Vite
 * dev-server's WS proxy (it ECONNREFUSEs on a cold start while the API
 * isn't up yet, then refuses to restore the proxy session even after the
 * API comes back) and talk to the API directly via CORS — `attachIo()`
 * already permits `WEB_ORIGIN`. In prod we keep same-origin so the same
 * reverse proxy that fronts the API also fronts /socket.io.
 *
 *   - VITE_PUBLIC_WS_URL  → explicit override (e.g. https://api.example.com)
 *   - VITE_PUBLIC_API_URL → reused: socket lives at the same origin as REST
 *   - else dev / undefined → http://localhost:4000
 *   - prod → undefined → same-origin
 */
function getWsTarget(): string | undefined {
  const env = (import.meta as unknown as {
    env?: Record<string, string | undefined>;
  }).env;
  const explicit = env?.VITE_PUBLIC_WS_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const apiUrl = env?.VITE_PUBLIC_API_URL;
  if (apiUrl) {
    try {
      return new URL(apiUrl).origin;
    } catch {
      /* fall through */
    }
  }
  if (env?.DEV) return 'http://localhost:4000';
  return undefined;
}

export function getSocket(): Socket {
  if (socket) return socket;
  const target = getWsTarget();
  socket = target
    ? io(target, {
        path: '/socket.io',
        transports: ['websocket', 'polling'],
        autoConnect: true,
        withCredentials: true,
        auth: () => ({ token: getToken() ?? undefined }),
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      })
    : io({
        path: '/socket.io',
        transports: ['websocket', 'polling'],
        autoConnect: true,
        auth: () => ({ token: getToken() ?? undefined }),
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export interface RealtimeEvents {
  'message.new': { conversationId: string; messageId: string; direction: 'in' | 'out'; text: string };
  'suggestion.new': { conversationId: string; suggestionId: string };
  'suggestion.approved': { conversationId: string; suggestionId: string; auto?: boolean };
  'status.changed': { conversationId: string; status: string };
  'mode.changed': { conversationId: string; mode: 'auto' | 'semi_auto' | 'assisted' | 'manual' };
  'channel.progress': { channelId: string; status: string; pct?: number };
  'campaign.tick': { campaignId: string; sent?: number; replies?: number };
  'dashboard.update': Record<string, number>;
  'operator.assigned': { conversationId: string; reason: string; urgency: 'low' | 'normal' | 'high' };
  'agent.failed': { conversationId: string; agentName: string; code?: string; reason: string };
  'quality.gate': {
    conversationId: string;
    score: number;
    action: 'continue' | 'soften' | 'handoff_silent';
    reasons: string[];
    decidedAt: string;
  };
}

export function useRoom<E extends keyof RealtimeEvents>(
  room: string | (() => string | null | undefined),
  event: E,
  handler: (payload: RealtimeEvents[E]) => void,
): void {
  let joinedRoom: string | null = null;
  const wrapped = (payload: RealtimeEvents[E]): void => handler(payload);

  function resolve(): string | null {
    const r = typeof room === 'function' ? room() : room;
    return r ? r : null;
  }

  onMounted(() => {
    const r = resolve();
    if (!r) return;
    joinedRoom = r;
    const s = getSocket();
    s.emit('room:join', r);
    s.on(event as string, wrapped as (...args: unknown[]) => void);
  });

  onBeforeUnmount(() => {
    if (!joinedRoom) return;
    const s = getSocket();
    s.off(event as string, wrapped as (...args: unknown[]) => void);
    s.emit('room:leave', joinedRoom);
    joinedRoom = null;
  });
}

export function joinRoom(room: string): void {
  getSocket().emit('room:join', room);
}

export function leaveRoom(room: string): void {
  getSocket().emit('room:leave', room);
}
