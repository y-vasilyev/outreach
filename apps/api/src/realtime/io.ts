import { Server as IOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server as HTTPServer } from 'http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RealtimeEvent, RealtimeRoom } from '@nosquare/shared';
import { getRedisPub, getRedisRealtimeSub, getRedisSub } from '../redis.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getPrisma } from '@nosquare/db';

const REALTIME_CHANNEL_PREFIX = 'realtime:';

let _io: IOServer | undefined;

interface SocketUser {
  id: string;
  role: 'admin' | 'operator' | 'viewer';
  email?: string;
}

export function attachIo(httpServer: HTTPServer): IOServer {
  if (_io) return _io;
  const io = new IOServer(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
  });

  io.adapter(createAdapter(getRedisPub(), getRedisSub()));

  io.use((socket, next) => {
    const tokenFromAuth = (socket.handshake.auth as { token?: string } | undefined)?.token;
    const tokenFromHeader = socket.handshake.headers.authorization?.replace(/^Bearer /, '');
    const token = tokenFromAuth ?? tokenFromHeader ?? '';
    logger.info(
      {
        sid: socket.id,
        addr: socket.handshake.address,
        url: socket.handshake.url,
        hasAuthToken: !!tokenFromAuth,
        hasHeaderToken: !!tokenFromHeader,
        transport: socket.conn.transport.name,
      },
      'ws handshake',
    );
    if (!token) {
      logger.warn({ sid: socket.id }, 'ws handshake rejected: no token');
      return next(new Error('No token'));
    }
    const user = verifyJwt(token);
    if (!user) {
      logger.warn({ sid: socket.id }, 'ws handshake rejected: invalid token');
      return next(new Error('Invalid token'));
    }
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    logger.info({ sid: socket.id }, 'ws connect');
    // Accept both naming conventions: the web client emits room:join /
    // room:leave; older code paths use subscribe / unsubscribe.
    const join = (room: RealtimeRoom): void => {
      void canJoinRoom(socket.data.user as SocketUser | undefined, room)
        .then((allowed) => {
          if (!allowed) {
            logger.warn({ sid: socket.id, room }, 'ws room join denied');
            return;
          }
          socket.join(room);
          logger.info({ sid: socket.id, room }, 'ws room joined');
        })
        .catch((err) => {
          logger.warn({ sid: socket.id, room, err: (err as Error).message }, 'ws room join failed');
        });
    };
    const leave = (room: RealtimeRoom): void => {
      socket.leave(room);
    };
    socket.on('subscribe', join);
    socket.on('unsubscribe', leave);
    socket.on('room:join', join);
    socket.on('room:leave', leave);
    socket.on('disconnect', (reason) => {
      logger.info({ sid: socket.id, reason }, 'ws disconnect');
    });
  });

  // Bridge: workers publish RealtimeEvents to Redis pub/sub on
  // `realtime:<room>`; this process subscribes to the pattern and rebroadcasts
  // each event into its Socket.IO room. Without this, inbound TG messages
  // (and suggestion updates from agent-run) never reach the inbox UI.
  bridgeRedisToSocketIo(io);

  _io = io;
  return io;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function verifyJwt(token: string): SocketUser | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = b64url(createHmac('sha256', env.JWT_SECRET).update(`${header}.${payload}`).digest());
  const sig = Buffer.from(signature);
  const exp = Buffer.from(expected);
  if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) return null;

  let jwtHeader: { alg?: unknown; typ?: unknown };
  let body: { id?: unknown; role?: unknown; email?: unknown; exp?: unknown };
  try {
    jwtHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (jwtHeader.alg !== 'HS256') return null;
  if (jwtHeader.typ !== undefined && jwtHeader.typ !== 'JWT') return null;
  if (typeof body.exp === 'number' && body.exp * 1000 < Date.now()) return null;
  if (typeof body.id !== 'string') return null;
  if (body.role !== 'admin' && body.role !== 'operator' && body.role !== 'viewer') return null;
  return {
    id: body.id,
    role: body.role,
    ...(typeof body.email === 'string' ? { email: body.email } : {}),
  };
}

async function canJoinRoom(user: SocketUser | undefined, room: RealtimeRoom): Promise<boolean> {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (room === 'admin:dashboard') return false;

  if (room.startsWith('operator:')) {
    const id = room.slice('operator:'.length);
    return user.role === 'operator' && (id === user.id || id === 'default');
  }

  if (room.startsWith('conversation:')) {
    if (user.role !== 'operator') return false;
    const id = room.slice('conversation:'.length);
    const conv = await getPrisma().conversation.findUnique({
      where: { id },
      select: { assignedOperatorId: true },
    });
    return !!conv && (!conv.assignedOperatorId || conv.assignedOperatorId === user.id);
  }

  if (room.startsWith('channel:')) {
    if (user.role !== 'operator') return false;
    const id = room.slice('channel:'.length);
    const channel = await getPrisma().channel.findUnique({
      where: { id },
      select: { addedById: true },
    });
    return !!channel && (!channel.addedById || channel.addedById === user.id);
  }

  if (room.startsWith('campaign:')) {
    if (user.role !== 'operator') return false;
    const id = room.slice('campaign:'.length);
    const campaign = await getPrisma().campaign.findUnique({
      where: { id },
      select: { createdById: true },
    });
    return !!campaign && (!campaign.createdById || campaign.createdById === user.id);
  }

  return false;
}

function bridgeRedisToSocketIo(io: IOServer): void {
  const sub = getRedisRealtimeSub();
  sub
    .psubscribe(`${REALTIME_CHANNEL_PREFIX}*`)
    .then(() => logger.info({ pattern: `${REALTIME_CHANNEL_PREFIX}*` }, 'realtime: bridge psubscribed'))
    .catch((err) => logger.error({ err }, 'realtime: failed to psubscribe'));
  sub.on('pmessage', (_pattern, channel, raw) => {
    const room = channel.slice(REALTIME_CHANNEL_PREFIX.length) as RealtimeRoom;
    if (!room) return;
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch (err) {
      logger.warn({ err, channel }, 'realtime: dropped non-JSON payload');
      return;
    }
    if (!event?.type) return;
    // Count sockets in the target room so we can tell "no one's listening"
    // apart from "broadcast went out but client missed it". `fetchSockets`
    // returns the live list across all worker instances via the Redis
    // adapter.
    void io
      .in(room)
      .fetchSockets()
      .then((sockets) => {
        logger.info(
          { room, type: event.type, recipients: sockets.length },
          'realtime: bridge → io.emit',
        );
        io.to(room).emit(event.type, event);
      })
      .catch((err) => {
        logger.warn({ err, room }, 'realtime: fetchSockets failed; emitting anyway');
        io.to(room).emit(event.type, event);
      });
  });
}

export function getIo(): IOServer {
  if (!_io) throw new Error('Socket.IO not initialized');
  return _io;
}

export function emitToRoom(room: RealtimeRoom, event: RealtimeEvent): void {
  if (!_io) return;
  _io.to(room).emit(event.type, event);
}
