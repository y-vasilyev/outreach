import IORedis from 'ioredis';
import { env } from './env.js';

let _redis: IORedis | undefined;
let _pub: IORedis | undefined;
let _sub: IORedis | undefined;
let _realtimeSub: IORedis | undefined;

export function getRedis(): IORedis {
  if (!_redis) _redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return _redis;
}

export function getRedisPub(): IORedis {
  if (!_pub) _pub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return _pub;
}

export function getRedisSub(): IORedis {
  if (!_sub) _sub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return _sub;
}

/**
 * Dedicated subscriber connection for the worker→API realtime bridge.
 * Cannot reuse `_sub` because the Socket.IO Redis adapter holds it in
 * subscribe-mode for inter-instance broadcasts; a single ioredis client
 * in subscribe mode can't be shared by another consumer.
 */
export function getRedisRealtimeSub(): IORedis {
  if (!_realtimeSub) _realtimeSub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return _realtimeSub;
}
