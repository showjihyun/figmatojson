/**
 * Service barrel — single import point for every client-side service.
 * Components and hooks should `import { ... } from '@/services'` rather than
 * reaching into individual files.
 */

export {
  documentService,
  type DocumentService,
  type UploadResult,
  type HistoryResult,
} from './DocumentService';
export { sessionService, type SessionService } from './SessionService';
export {
  chatService,
  type ChatService,
  type ChatMessage,
  type ChatAction,
  type ChatSendInput,
  type ChatSendResult,
  type AuthMode,
  ChatHttpError,
} from './ChatService';
export { preferencesService, type PreferencesService } from './PreferencesService';
