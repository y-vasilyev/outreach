export interface Channel {
  id: string;
  platform: 'telegram' | 'instagram' | 'youtube';
  handle: string;
  title: string;
  description?: string;
  followers?: number;
  language?: string;
  status: string;
  /** Prisma-style relation count from `findMany`. */
  _count?: { contacts: number };
  source?: string;
  scrapedAt?: string;
  createdAt: string;
  updatedAt?: string;
  /** `red_flags` is intentional snake_case in the analyzer schema. */
  analysis?: { topic?: string; tone?: string; red_flags?: string[] } | null;
  lastError?: string | null;
}
