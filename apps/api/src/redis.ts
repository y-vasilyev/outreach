import IORedis from 'ioredis';
import { env } from './env.js';

let _redis: IORedis | undefined;
let _pub: IORedis | undefined;
let _sub: IORedis | undefined;

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
