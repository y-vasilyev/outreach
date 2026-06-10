import { z } from 'zod';

/**
 * Operator-maintained exchange rates (price-normalization-v2). Currency codes
 * are ISO-4217-style uppercase letters; RUB itself is not a rate row (offers
 * in RUB normalize with rate 1 implicitly).
 */
export const ExchangeRateCurrencyZ = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'three-letter currency code expected')
  .refine((c) => c !== 'RUB', { message: 'RUB needs no exchange rate' });

export const ExchangeRateUpsertZ = z.object({
  rateToRub: z.number().positive().finite(),
  /** Effective date of the rate; defaults to now on the server. */
  asOf: z.coerce.date().optional(),
});
export type ExchangeRateUpsert = z.infer<typeof ExchangeRateUpsertZ>;

export const ExchangeRateViewZ = z.object({
  currency: z.string(),
  rateToRub: z.number(),
  asOf: z.string(),
  source: z.string(),
  updatedById: z.string().nullable(),
  updatedAt: z.string(),
});
export type ExchangeRateView = z.infer<typeof ExchangeRateViewZ>;
