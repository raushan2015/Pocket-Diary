/**
 * React Native attachment cache backed by expo-file-system.
 *
 * `FileSystem.downloadAsync` performs the fetch natively with our explicit
 * `Cookie` header — the session cookie must accompany the request and the OS
 * cookie jar must not be consulted (the API client pins `credentials: 'omit'`).
 *
 * SDK 54 moved the classic functions to the `legacy` subpath; downloads are
 * not part of the new File/Paths API yet.
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { ApiClient } from '@/services/api/client';
import { ApiError } from '@/services/api/transport';
import type { AttachmentCache, CachedAttachmentRef } from './cache';
import { attachmentCookieHeader, attachmentPath, cacheExtension } from './cache';

const CACHE_DIR = `${FileSystem.documentDirectory}attachments/`;

export class RnAttachmentCache implements AttachmentCache {
  private dirReady: Promise<void> | null = null;

  private ensureDir(): Promise<void> {
    if (!this.dirReady) {
      this.dirReady = (async () => {
        const info = await FileSystem.getInfoAsync(CACHE_DIR);
        if (!info.exists) {
          await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
        }
      })().catch((err) => {
        this.dirReady = null;
        throw err;
      });
    }
    return this.dirReady;
  }

  private localPath(att: CachedAttachmentRef): string {
    return `${CACHE_DIR}${att.id}${cacheExtension(att.fileName, att.mimeType)}`;
  }

  async ensureCached(api: ApiClient, att: CachedAttachmentRef): Promise<string | null> {
    const path = this.localPath(att);
    try {
      await this.ensureDir();
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) return path;

      const result = await FileSystem.downloadAsync(
        api.url(attachmentPath(att.id)),
        path,
        { headers: attachmentCookieHeader(api.getToken()) },
      );
      if (result.status >= 200 && result.status < 300) {
        return path;
      }
      await FileSystem.deleteAsync(path, { idempotent: true });
      return null;
    } catch (err) {
      if (err instanceof ApiError) return null; // offline / server refused
      try {
        await FileSystem.deleteAsync(path, { idempotent: true });
      } catch {
        // best-effort cleanup
      }
      return null;
    }
  }

  async remove(att: CachedAttachmentRef): Promise<void> {
    try {
      await FileSystem.deleteAsync(this.localPath(att), { idempotent: true });
    } catch {
      // best-effort
    }
  }
}
