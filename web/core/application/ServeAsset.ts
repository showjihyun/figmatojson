/**
 * Use case: serve an extracted image asset by hash.
 *
 * Trivial wrapper around AssetServer — kept as a use case so the route
 * layer's asset endpoint can call `serveAsset.execute(...)` like every
 * other endpoint and stay symmetrical.
 */

import type { AssetServer, Asset } from '../ports/AssetServer.js';
import { NotFoundError, ValidationError } from './errors.js';

export interface ServeAssetInput {
  sessionId: string;
  hashHex: string;
}

export class ServeAsset {
  constructor(private readonly assetServer: AssetServer) {}

  async execute({ sessionId, hashHex }: ServeAssetInput): Promise<Asset> {
    if (!/^[0-9a-f]{40}$/.test(hashHex)) {
      throw new ValidationError(`invalid hash: ${hashHex}`);
    }
    const asset = await this.assetServer.fetch(sessionId, hashHex);
    if (!asset) throw new NotFoundError(`asset ${hashHex} not found in session ${sessionId}`);
    return asset;
  }
}
