import { describe, expect, it } from 'vitest';
import { ServeAsset } from './ServeAsset.js';
import { NotFoundError, ValidationError } from './errors.js';
import type { Asset, AssetServer } from '../ports/AssetServer.js';

class FakeAssetServer implements AssetServer {
  constructor(private readonly fixtures: Map<string, Asset>) {}
  async fetch(_sessionId: string, hashHex: string): Promise<Asset | null> {
    return this.fixtures.get(hashHex) ?? null;
  }
}

const VALID_HASH = '0123456789abcdef0123456789abcdef01234567';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // partial PNG header

describe('ServeAsset', () => {
  it('returns the underlying Asset for a valid hash that exists', async () => {
    const fixtures = new Map<string, Asset>([
      [VALID_HASH, { bytes: PNG_BYTES, mime: 'image/png' }],
    ]);
    const useCase = new ServeAsset(new FakeAssetServer(fixtures));
    const asset = await useCase.execute({ sessionId: 'any', hashHex: VALID_HASH });
    expect(asset.mime).toBe('image/png');
    expect(asset.bytes).toBe(PNG_BYTES);
  });

  it('rejects non-40-char-hex (path traversal defense)', async () => {
    const useCase = new ServeAsset(new FakeAssetServer(new Map()));
    for (const bad of ['', 'short', '../etc/passwd', VALID_HASH.toUpperCase(), 'g'.repeat(40)]) {
      await expect(useCase.execute({ sessionId: 'x', hashHex: bad }))
        .rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('throws NotFoundError when the asset is unknown', async () => {
    const useCase = new ServeAsset(new FakeAssetServer(new Map()));
    await expect(useCase.execute({ sessionId: 'x', hashHex: VALID_HASH }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});
