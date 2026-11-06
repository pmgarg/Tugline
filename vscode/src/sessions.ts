/**
 * Chat history (SPEC B6). The implementation is shared with `tug sessions` since v1.2 N49:
 * see src/cli/sessions.ts (rename → titles.json, delete → trash/, resume, search, export).
 * Re-exported by name (this package is CommonJS for tsx/esbuild; star re-exports are not visible to ESM importers).
 */
import * as s from '../../src/cli/sessions.js';

export type { SessionInfo, SearchHit } from '../../src/cli/sessions.js';
export const sessionsDir = s.sessionsDir;
export const titleFromPrompt = s.titleFromPrompt;
export const firstPrompt = s.firstPrompt;
export const listSessions = s.listSessions;
export const findSession = s.findSession;
export const renameSession = s.renameSession;
export const deleteSession = s.deleteSession;
export const loadSessionMessages = s.loadSessionMessages;
export const searchSessions = s.searchSessions;
export const exportMessages = s.exportMessages;
export const favoriteIds = s.favoriteIds;
export const toggleFavorite = s.toggleFavorite;
export const sessionsSize = s.sessionsSize;
export const deleteAllSessions = s.deleteAllSessions;
