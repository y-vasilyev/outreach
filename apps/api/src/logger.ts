import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.api_key',
      '*.apiKey',
      '*.session_encrypted',
      '*.config_encrypted',
      '*.auth_encrypted',
      '*.password',
      '*.passwordHash',
    ],
    censor: '[REDACTED]',
  },
});
