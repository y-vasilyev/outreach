import { AppError } from '@nosquare/shared/errors';
import type { Platform, PlatformAdapter } from './types.js';

class PlatformRegistry {
  private map = new Map<Platform, PlatformAdapter>();

  register(a: PlatformAdapter): void {
    this.map.set(a.platform, a);
  }

  get(p: Platform): PlatformAdapter {
    const adapter = this.map.get(p);
    if (!adapter) {
      throw new AppError('NOT_FOUND', `platform adapter "${p}" not registered`, 404);
    }
    return adapter;
  }

  has(p: Platform): boolean {
    return this.map.has(p);
  }
}

export const platformRegistry = new PlatformRegistry();
export type { PlatformRegistry };
