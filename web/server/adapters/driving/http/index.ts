/**
 * registerRoutes — single entry point that wires every HTTP route onto the
 * Hono app. server/index.ts builds a Deps bundle and calls this once;
 * route files stay focused on translating HTTP shapes to use case calls.
 */

import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { registerUploadRoute } from './uploadRoute.js';
import { registerDocRoutes } from './docRoute.js';
import { registerAssetRoute } from './assetRoute.js';
import { registerSaveRoute } from './saveRoute.js';
import { registerOverrideRoute } from './overrideRoute.js';
import { registerResizeRoute } from './resizeRoute.js';
import { registerSnapshotRoutes } from './snapshotRoute.js';
import { registerChatRoute } from './chatRoute.js';

export function registerRoutes(app: Hono, deps: Deps): void {
  registerUploadRoute(app, deps);
  registerDocRoutes(app, deps);
  registerAssetRoute(app, deps);
  registerSaveRoute(app, deps);
  registerOverrideRoute(app, deps);
  registerResizeRoute(app, deps);
  registerSnapshotRoutes(app, deps);
  registerChatRoute(app, deps);
}

export type { Deps } from './deps.js';
