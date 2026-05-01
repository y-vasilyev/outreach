import { describe, expect, it } from 'vitest';

import { classifyTgError } from '../SessionManager.js';

/**
 * The bug we're locking down: previously `mapTgError` treated ANY 403 as
 * session-dead, which meant a single recipient blocking us could mark the
 * entire TG account as `need_auth`. The new classifier separates "this
 * peer is unreachable" (CHAT_WRITE_FORBIDDEN, USER_PRIVACY_RESTRICTED, …)
 * from real session failures (AUTH_KEY_*, SESSION_REVOKED, USER_DEACTIVATED).
 */
describe('classifyTgError', () => {
  it('classifies CHAT_WRITE_FORBIDDEN as peer-permanent', () => {
    expect(classifyTgError({ message: 'CHAT_WRITE_FORBIDDEN' })).toBe('peer_permanent');
    // Real format from GramJS RPCError — has trailing context.
    expect(
      classifyTgError({ message: 'CHAT_WRITE_FORBIDDEN (caused by messages.SendMessage)' }),
    ).toBe('peer_permanent');
  });

  it('classifies USER_PRIVACY_RESTRICTED as peer-permanent', () => {
    expect(classifyTgError({ message: 'USER_PRIVACY_RESTRICTED' })).toBe('peer_permanent');
  });

  it('classifies USER_IS_BLOCKED / YOU_BLOCKED_USER as peer-permanent', () => {
    expect(classifyTgError({ message: 'USER_IS_BLOCKED' })).toBe('peer_permanent');
    expect(classifyTgError({ message: 'YOU_BLOCKED_USER' })).toBe('peer_permanent');
  });

  it('classifies INPUT_USER_DEACTIVATED as peer-permanent (recipient deleted account)', () => {
    expect(classifyTgError({ message: 'INPUT_USER_DEACTIVATED' })).toBe('peer_permanent');
  });

  it('classifies PEER_ID_INVALID / USERNAME_INVALID as peer-permanent', () => {
    expect(classifyTgError({ message: 'PEER_ID_INVALID' })).toBe('peer_permanent');
    expect(classifyTgError({ message: 'USERNAME_NOT_OCCUPIED' })).toBe('peer_permanent');
  });

  it('classifies AUTH_KEY_UNREGISTERED as session-dead (our session)', () => {
    expect(classifyTgError({ message: 'AUTH_KEY_UNREGISTERED' })).toBe('session_dead');
  });

  it('classifies SESSION_REVOKED as session-dead', () => {
    expect(classifyTgError({ message: 'SESSION_REVOKED' })).toBe('session_dead');
  });

  it('classifies USER_DEACTIVATED as session-dead (our account, not recipient)', () => {
    // Distinct from INPUT_USER_DEACTIVATED — this means OUR account was
    // deactivated by Telegram. Must require re-auth.
    expect(classifyTgError({ message: 'USER_DEACTIVATED' })).toBe('session_dead');
  });

  it('does NOT confuse USER_DEACTIVATED and INPUT_USER_DEACTIVATED', () => {
    expect(classifyTgError({ message: 'INPUT_USER_DEACTIVATED' })).toBe('peer_permanent');
    expect(classifyTgError({ message: 'USER_DEACTIVATED' })).toBe('session_dead');
  });

  it('classifies FloodWait by `seconds` field as flood', () => {
    expect(classifyTgError({ seconds: 30, message: 'FLOOD_WAIT_30' })).toBe('flood');
  });

  it('classifies FLOOD_WAIT_<n> message as flood', () => {
    expect(classifyTgError({ message: 'FLOOD_WAIT_42' })).toBe('flood');
  });

  it('falls back to transient for unknown errors', () => {
    expect(classifyTgError({ message: 'random network blip' })).toBe('transient');
    expect(classifyTgError({ message: 'TIMEOUT' })).toBe('transient');
    expect(classifyTgError({})).toBe('transient');
  });

  it('reads errorMessage when message is absent', () => {
    expect(classifyTgError({ errorMessage: 'CHAT_WRITE_FORBIDDEN' })).toBe('peer_permanent');
  });
});
