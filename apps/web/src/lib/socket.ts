import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
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
  'status.changed': { conversationId: string; status: string };
  'mode.changed': { conversationId: string; mode: 'auto' | 'assisted' | 'manual' };
  'channel.progress': { channelId: string; status: string; pct?: number };
  'campaign.tick': { campaignId: string; sent?: number; replies?: number };
  'dashboard.update': Record<string, number>;
}

export function useRoom<E extends keyof RealtimeEvents>(
  room: string | null | undefined,
  event: E,
  handler: (payload: RealtimeEvents[E]) => void,
): void {
  useEffect(() => {
    if (!room) return;
    const s = getSocket();
    s.emit('room:join', room);
    const wrapped = (payload: RealtimeEvents[E]): void => handler(payload);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.on(event as string, wrapped as any);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.off(event as string, wrapped as any);
      s.emit('room:leave', room);
    };
  }, [room, event, handler]);
}

export function joinRoom(room: string): void {
  getSocket().emit('room:join', room);
}

export function leaveRoom(room: string): void {
  getSocket().emit('room:leave', room);
}
