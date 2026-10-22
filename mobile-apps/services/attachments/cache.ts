/**
 * Attachment binary cache.
 *
 * Server attachments are auth-protected (`GET /attachments/:id/file` requires
 * the `memo_session` cookie), so a plain `<Image source={{ uri: url }}>` can
 * never load them. Files are therefore downloaded through the ApiClient (with
 * the session cookie) and cached on disk so they render offline.
 *
 * `null` means "not available offline right now" — callers surface a
 * "download needed / offline" state instead of pretending to show the file.
 */
import type { ApiClient } from '@/services/api/client';
import { attachmentPath } from '@/services/api/endpoints';
import { SESSION_COOKIE_NAME } from '@/services/api/contracts';

export interface CachedAttachmentRef {
  id: string;
  fileName: string;
  mimeType: string;
}

export interface AttachmentCache {
  /**
   * Returns a local file path, downloading through the API client when
   * necessary. Cheap when already cached. Resolves null when the file is
   * not available offline right now (offline / server refused / deleted) —
   * callers surface a "download needed" state instead of a broken image.
   */
  ensureCached(api: ApiClient, att: CachedAttachmentRef): Promise<string | null>;
  /** Removes one cached file (no-op when absent). */
  remove(att: CachedAttachmentRef): Promise<void>;
}

/** Extension for a cache file name, derived from the original name or MIME. */
export function cacheExtension(fileName: string, mimeType: string): string {
  const fromName = fileName.includes('.') ? `.${fileName.split('.').pop()}` : '';
  if (fromName) return fromName.toLowerCase();
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'application/pdf':
      return '.pdf';
    case 'text/plain':
      return '.txt';
    case 'text/markdown':
      return '.md';
    default:
      return '.bin';
  }
}

export function attachmentCookieHeader(token: string | null): Record<string, string> {
  return token ? { Cookie: `${SESSION_COOKIE_NAME}=${token}` } : {};
}

export { attachmentPath };
