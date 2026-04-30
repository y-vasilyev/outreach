import { getPrisma, decryptJson } from '@nosquare/db';
import { ScrapeCreatorsClient } from '@nosquare/platforms';

let _client: ScrapeCreatorsClient | null | undefined;

export async function getScrapeCreators(): Promise<ScrapeCreatorsClient | null> {
  if (_client !== undefined) return _client;
  const prisma = getPrisma();
  const integ = await prisma.integration.findUnique({ where: { kind: 'scrapecreators' } });
  if (!integ || !integ.enabled) {
    _client = null;
    return null;
  }
  const cfg = await decryptJson<{ apiKey: string; baseUrl: string }>(integ.configEncrypted);
  _client = new ScrapeCreatorsClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  return _client;
}
