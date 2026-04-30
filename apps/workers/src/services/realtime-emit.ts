import { getRedis } from '../redis.js';
import type { RealtimeEvent, RealtimeRoom } from '@nosquare/shared';

const CHANNEL_PREFIX = 'realtime:';

/**
 * Workers don't host Socket.IO. They publish events into Redis;
 * the API process subscribes and broadcasts to rooms via Socket.IO Redis adapter.
 * For MVP we simply publish JSON to a pub/sub channel that the API listens to.
 */
export async function publishRealtime(room: RealtimeRoom, event: RealtimeEvent): Promise<void> {
  const r = getRedis();
  await r.publish(`${CHANNEL_PREFIX}${room}`, JSON.stringify(event));
}
