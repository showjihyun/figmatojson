/**
 * PreferencesService — single source of truth for user preferences that
 * persist across sessions (today: localStorage, tomorrow maybe a settings
 * endpoint). Three values:
 *   - apiKey: Anthropic sk-ant-... key (only used in api-key mode)
 *   - model:  selected Claude model id
 *   - authMode: 'subscription' | 'api-key'
 *
 * Key namespacing (`figrev_*`) stays here so consumers don't accidentally
 * collide with localStorage from other apps on the same origin.
 */

import type { AuthMode } from './ChatService';

const KEYS = {
  apiKey: 'figrev_anthropic_key',
  model: 'figrev_claude_model',
  authMode: 'figrev_auth_mode',
} as const;

export interface PreferencesService {
  getApiKey(): string;
  setApiKey(value: string): void;

  getModel(defaultModel: string): string;
  setModel(model: string): void;

  getAuthMode(defaultMode: AuthMode): AuthMode;
  setAuthMode(mode: AuthMode): void;
}

class LocalStoragePreferencesService implements PreferencesService {
  getApiKey(): string {
    return localStorage.getItem(KEYS.apiKey) ?? '';
  }
  setApiKey(value: string): void {
    if (value) localStorage.setItem(KEYS.apiKey, value);
    else localStorage.removeItem(KEYS.apiKey);
  }

  getModel(defaultModel: string): string {
    return localStorage.getItem(KEYS.model) ?? defaultModel;
  }
  setModel(model: string): void {
    localStorage.setItem(KEYS.model, model);
  }

  getAuthMode(defaultMode: AuthMode): AuthMode {
    const v = localStorage.getItem(KEYS.authMode) as AuthMode | null;
    return v === 'subscription' || v === 'api-key' ? v : defaultMode;
  }
  setAuthMode(mode: AuthMode): void {
    localStorage.setItem(KEYS.authMode, mode);
  }
}

export const preferencesService: PreferencesService = new LocalStoragePreferencesService();
