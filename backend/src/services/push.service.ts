/**
 * Web Push delivery service (optional, VAPID-driven).
 * Disabled unless VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are configured.
 */
import webpush from 'web-push';
import { eq } from 'drizzle-orm';
import { pushSubscriptions } from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';
import { pushConfig } from '../config.js';

let initialized = false;

function ensureInitialized(): boolean {
  if (!pushConfig.enabled) return false;
  if (!initialized) {
    webpush.setVapidDetails(pushConfig.subject, pushConfig.publicKey, pushConfig.privateKey);
    initialized = true;
  }
  return true;
}

export function isPushEnabled(): boolean {
  return pushConfig.enabled;
}

export function getPushPublicKey(): string | null {
  return pushConfig.enabled ? pushConfig.publicKey : null;
}

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  memoId?: string;
  notificationId?: string;
}

/** Send one push to every subscription of a user. Returns the number delivered. */
export async function sendPushToUser(
  dbCtx: DatabaseContext,
  userId: string,
  payload: PushPayload,
): Promise<number> {
  if (!ensureInitialized()) return 0;

  const subs = dbCtx.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .all();

  let delivered = 0;
  const deadEndpoints: string[] = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { TTL: 24 * 60 * 60, urgency: 'normal' },
        );
        delivered++;
      } catch (error: any) {
        // 404/410: subscription is gone — prune it. Other errors: ignore, will retry next time.
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          deadEndpoints.push(sub.endpoint);
        }
      }
    }),
  );

  if (deadEndpoints.length) {
    for (const endpoint of deadEndpoints) {
      dbCtx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
    }
  }

  return delivered;
}
