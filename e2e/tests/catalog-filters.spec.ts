import { test, expect } from '@playwright/test';

/**
 * Catalog filter bar happy path (catalog-sql-search 4.3): the operator core
 * query «телеграм-посты до 50 000 ₽, свежее 60 дней» runs SERVER-side and the
 * UI reflects exactly the matching profiles. Seeded by e2e/seed-e2e.ts:
 *   eg-tg-cheap  47k ₽ fresh  → the only expected match
 *   eg-tg-pricey 80k ₽ fresh  → filtered by price
 *   eg-ig-cheap  30k ₽ fresh  → filtered by platform
 *   eg-tg-stale  40k ₽ old    → filtered by freshness
 */

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:4000';

test('телеграм-посты до 50к свежее 60 дней — server-driven filters', async ({ page, request }) => {
  // Authenticate via the API and inject the token the web client reads.
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email: 'e2e@nosquare.local', password: 'e2e-password' },
  });
  expect(login.ok()).toBeTruthy();
  const { token } = (await login.json()) as { token: string };
  await page.addInitScript((t) => localStorage.setItem('nosquare.token', t), token);

  await page.goto('/bloggers');

  // Unfiltered catalog shows all four seeded profiles.
  await expect(page.getByText('eg-tg-cheap').first()).toBeVisible();
  await expect(page.getByText('eg-tg-pricey').first()).toBeVisible();
  await expect(page.getByText('eg-ig-cheap').first()).toBeVisible();
  await expect(page.getByText('eg-tg-stale').first()).toBeVisible();

  // The operator core query: platform + price cap + freshness.
  const catalogRefetch = page.waitForResponse(
    (r) =>
      r.url().includes('/blogger-profiles') &&
      r.url().includes('platform=telegram') &&
      r.url().includes('priceRubMax=50000') &&
      r.url().includes('offerFreshDays=60') &&
      r.ok(),
  );
  // FilterChipSelect is a custom dropdown: open the chip, pick the option.
  await page.getByRole('button', { name: /Платформа/ }).click();
  await page.getByRole('button', { name: 'Telegram', exact: true }).click();
  await page.getByPlaceholder('Цена до, ₽').fill('50000');
  await page.getByPlaceholder('Свежее, дн.').fill('60');
  await catalogRefetch;

  // Only the cheap fresh Telegram profile survives — the rest were filtered
  // by the SERVER (price / platform / freshness), not by client-side slicing.
  await expect(page.getByText('eg-tg-cheap').first()).toBeVisible();
  await expect(page.getByText('eg-tg-pricey')).toHaveCount(0);
  await expect(page.getByText('eg-ig-cheap')).toHaveCount(0);
  await expect(page.getByText('eg-tg-stale')).toHaveCount(0);
});
