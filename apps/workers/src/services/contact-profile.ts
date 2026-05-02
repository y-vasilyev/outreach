import { getPrisma } from '@nosquare/db';
import { logger } from '../logger.js';
import { getTgClient } from './tg-client.js';

interface ContactForResolve {
  id: string;
  type: string;
  value: string;
  tgUserId: string | null;
}

function resolveTarget(c: ContactForResolve): string | null {
  if (c.tgUserId) return null;
  if (c.type !== 'tg_username' && c.type !== 'tg_link') return null;

  const value = c.value
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/\/$/, '');

  // Private invite links cannot be resolved into a user profile.
  if (!value || value.startsWith('+') || value.toLowerCase().startsWith('joinchat/')) {
    return null;
  }
  return value;
}

export async function ensureContactTgProfile(
  tgAccountId: string,
  contact: ContactForResolve,
): Promise<void> {
  const target = resolveTarget(contact);
  if (!target) return;

  const tg = getTgClient();
  if (!tg) return;

  try {
    const handle = await tg.for(tgAccountId);
    const resolved = await handle.resolveUser(target);
    await getPrisma().contact.update({
      where: { id: contact.id },
      data: {
        tgUserId: resolved.id,
        tgUsername: resolved.username ?? null,
        tgFirstName: resolved.firstName ?? null,
        tgLastName: resolved.lastName ?? null,
      },
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, contactId: contact.id, tgAccountId },
      'contact-profile: resolveUser failed; opener will use extracted context only',
    );
  }
}
