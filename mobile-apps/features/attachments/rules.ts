/**
 * Attachment rules — mirror of the backend's upload contract
 * (backend/src/routes/attachments.ts: max 5 MB, magic-byte verified types).
 *
 * The mobile client validates BEFORE queueing an offline upload, so
 * unsupported picks are refused with a clear message instead of endlessly
 * failing at sync time.
 */

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/markdown',
] as const;

export type AllowedAttachmentMime = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

export interface PickedAttachment {
  /** Local file:// URI (picker copies into the cache directory). */
  uri: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

/** Resolves a MIME type from the file extension, falling back to the reported one. */
export function resolveMime(fileName: string, reportedMime?: string | null): string | null {
  const lower = fileName.toLowerCase();
  const extMatch = lower.match(/\.([a-z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : '';
  const byExt: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
  };
  if (ext && byExt[ext]) return byExt[ext];
  if (reportedMime && reportedMime !== 'application/octet-stream' && reportedMime !== '') {
    return reportedMime;
  }
  return null;
}

export interface AttachmentValidation {
  ok: boolean;
  mimeType: string | null;
  reason?: string;
}

/** Client-side validation with a user-facing reason for every unsupported case. */
export function validateAttachment(pick: { fileName: string; mimeType?: string | null; fileSize: number }): AttachmentValidation {
  const mime = resolveMime(pick.fileName, pick.mimeType);
  if (!mime) {
    return {
      ok: false,
      mimeType: null,
      reason:
        `"${pick.fileName || 'this file'}" has an unknown type. ` +
        'Supported: JPEG, PNG, WebP, GIF, PDF, TXT and MD files.',
    };
  }
  if (!(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime)) {
    return {
      ok: false,
      mimeType: mime,
      reason: `"${mime}" files aren't supported by the server. Supported: JPEG, PNG, WebP, GIF, PDF, TXT and MD.`,
    };
  }
  if (pick.fileSize > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      mimeType: mime,
      reason: `Files can be at most 5 MB; this one is ${Math.round(pick.fileSize / (1024 * 1024))} MB.`,
    };
  }
  if (pick.fileSize <= 0) {
    return {
      ok: false,
      mimeType: mime,
      reason: 'That file appears to be empty.',
    };
  }
  return { ok: true, mimeType: mime };
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}
