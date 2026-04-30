/**
 * Shared mappers from Prisma rows to the loose `Record<string, unknown>`
 * shapes the LLM agents consume. Templates render objects via JSON.stringify,
 * so every field here ends up visible by name in the prompt — that's why
 * we expose `first_name` / `last_name` / `channel_title` rather than the
 * Prisma-style camelCase: it reads more naturally for the model.
 *
 * The reason these mappers exist (rather than passing the Prisma row
 * directly): we need to thread the resolved TG profile (firstName /
 * lastName / username, populated by tg-send on the first outbound) into
 * every prompt so the opener can address the recipient by name. Without
 * this, the LLM either left a salutation off entirely or hallucinated
 * one based on the @handle.
 */
export interface ContactPromptRow {
  id: string;
  value: string;
  type: string;
  roleGuess: string;
  label: string | null;
  tgUsername: string | null;
  tgFirstName: string | null;
  tgLastName: string | null;
  channel: { title: string | null; handle: string; description: string | null } | null;
}

export function buildContactPromptInput(c: ContactPromptRow): Record<string, unknown> {
  return {
    id: c.id,
    value: c.value,
    type: c.type,
    role: c.roleGuess,
    label: c.label,
    first_name: c.tgFirstName,
    last_name: c.tgLastName,
    tg_username: c.tgUsername,
    channel_title: c.channel?.title ?? null,
    channel_handle: c.channel?.handle ?? null,
    channel_bio: c.channel?.description ?? null,
  };
}
