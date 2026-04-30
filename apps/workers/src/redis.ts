import IORedis from 'ioredis';
import { env } from './env.js';

let _redis: IORedis | undefined;
export function getRedis(): IORedis {
  if (!_redis) _redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return _redis;
}
