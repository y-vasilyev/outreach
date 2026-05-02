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
  rawValue: string;
  roleGuess: string;
  label: string | null;
  tgUsername: string | null;
  tgFirstName: string | null;
  tgLastName: string | null;
  channel: { title: string | null; handle: string; description: string | null } | null;
}

export function buildContactPromptInput(c: ContactPromptRow): Record<string, unknown> {
  const contextText = [c.label, c.rawValue, c.channel?.description]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join('\n');
  const nameHint =
    c.tgFirstName ??
    inferNameHint(contextText, c.roleGuess) ??
    null;

  return {
    id: c.id,
    value: c.value,
    raw_value: c.rawValue,
    type: c.type,
    role: c.roleGuess,
    label: c.label,
    first_name: c.tgFirstName,
    last_name: c.tgLastName,
    tg_username: c.tgUsername,
    recipient_name_hint: nameHint,
    context_note: contextText || null,
    channel_title: c.channel?.title ?? null,
    channel_handle: c.channel?.handle ?? null,
    channel_bio: c.channel?.description ?? null,
  };
}

function inferNameHint(text: string, role: string): string | null {
  if (!text) return null;
  const patterns = [
    /\b(?:я|это)\s+([А-ЯЁA-Z][а-яёa-z]{2,24})\b/u,
    /\bна\s+связи\s+([А-ЯЁA-Z][а-яёa-z]{2,24})\b/iu,
    /\b(?:автор|менеджер|админ|администратор)\s+([А-ЯЁA-Z][а-яёa-z]{2,24})\b/iu,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }

  // For owner contacts, channel bios often say "я Крис". For manager
  // contacts, do not borrow the author's name unless the text explicitly
  // names the manager/contact person.
  if (role !== 'owner') return null;
  const shortName = text.match(/\bя\s+([А-ЯЁA-Z][а-яёa-z]{2,16})[,.\s]/u);
  return shortName?.[1] ?? null;
}
