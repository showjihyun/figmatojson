import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Auto-unmount React trees between tests so getByRole / screen don't see
// previous test's DOM. RTL's default-cleanup hook only fires when @testing-
// library/react is imported with `globals: true`; we use explicit imports.
afterEach(() => {
  cleanup();
});

// jsdom doesn't implement Element.scrollTo / scrollIntoView. Stub them so
// components that auto-scroll (ChatPanel's message list) don't blow up
// during render.
if (typeof globalThis.window !== 'undefined') {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
