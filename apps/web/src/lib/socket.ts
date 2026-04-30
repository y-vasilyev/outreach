import { io, type Socket } from 'socket.io-client';
import { onBeforeUnmount, onMounted } from 'vue';
import { getToken } from './api';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;
  socket = io({
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
  'mode.changed': { conversationId: string; mode: 'auto' | 'assisted' | 'manual' };
  'channel.progress': { channelId: string; status: string; pct?: number };
  'campaign.tick': { campaignId: string; sent?: number; replies?: number };
  'dashboard.update': Record<string, number>;
  'operator.assigned': { conversationId: string; reason: string; urgency: 'low' | 'normal' | 'high' };
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
