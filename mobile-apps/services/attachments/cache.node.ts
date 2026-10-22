/**
 * Node attachment cache (test harness / real-backend integration runs).
 * Downloads through the same ApiClient transport (real fetch, cookie header)
 * and writes bytes to the OS temp directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApiClient } from '@/services/api/client';
import type { AttachmentCache, CachedAttachmentRef } from './cache';
import { attachmentCookieHeader, attachmentPath, cacheExtension } from './cache';

export class NodeAttachmentCache implements AttachmentCache {
  private readonly dir: string;

  constructor(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-attachments-'))) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  private localPath(att: CachedAttachmentRef): string {
    return path.join(this.dir, `${att.id}${cacheExtension(att.fileName, att.mimeType)}`);
  }

  async ensureCached(api: ApiClient, att: CachedAttachmentRef): Promise<string | null> {
    const filePath = this.localPath(att);
    if (fs.existsSync(filePath)) return filePath;
    try {
      // Byte-exact download: fetch the auth-protected file directly with the
      // session cookie (the shared transport's text() is not binary-safe).
      const res = await fetch(api.url(attachmentPath(att.id)), {
        headers: attachmentCookieHeader(api.getToken()),
      });
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, bytes);
      return filePath;
    } catch {
      return null; // offline / unreachable / invalid response
    }
  }

  async remove(att: CachedAttachmentRef): Promise<void> {
    try {
      fs.rmSync(this.localPath(att), { force: true });
    } catch {
      // best-effort
    }
  }
}
