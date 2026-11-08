/**
 * Hardened outbound fetch for AI provider calls (handoff §3).
 *
 * Security posture:
 *  - Endpoint URLs are compile-time constants inside each adapter. This
 *    helper validates that the FINAL URL is https (or plain http ONLY to a
 *    loopback/127.0.0.1 host when a non-production test override is active),
 *    so a stray override can never point production at an internal address.
 *  - redirect: 'error' — a provider must never bounce us to another origin
 *    (redirects to cloud-metadata endpoints are a classic SSRF path).
 *  - The API key is attached only as the Authorization/x-goog-api-key header
 *    of the request. It is never logged; error scrubbing happens in
 *    `scrubKeyMaterial`.
 *  - Wall-clock timeout + AbortSignal support, no retries here (the caller
 *    owns retry policy and must never auto-retry side-effectful tool turns).
 */
import { ProviderRequestError, providerFailureMessage, type ProviderErrorCode } from './provider-types.js';

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024; // 12 MB — far above any legitimate chat stream

export interface ProviderFetchOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Secrets that must never appear in thrown error messages. */
  secretsToScrub?: string[];
}

/** Removes any accidental key material from a user-facing error string. */
export function scrubKeyMaterial(text: string, secrets: string[] = []): string {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  // Common key shapes, best-effort.
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  out = out.replace(/nvapi-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  out = out.replace(/AIza[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [REDACTED]');
  return out.slice(0, 500);
}

function validateUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderRequestError('provider_error', 'Invalid provider endpoint URL');
  }
  const isLoopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1';
  const testOverrideActive = process.env.NODE_ENV !== 'production' && Boolean(
    process.env.AI_OPENAI_BASE_URL || process.env.AI_GEMINI_BASE_URL || process.env.AI_DEEPSEEK_BASE_URL || process.env.AI_NVIDIA_BASE_URL
  );
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback && testOverrideActive)) {
    throw new ProviderRequestError('provider_error', 'Provider endpoint must use HTTPS');
  }
  return url;
}

export interface ProviderStreamResponse {
  status: number;
  body: AsyncIterable<string>;
}

/**
 * Perform a validated provider HTTP request and return the response body as
 * an async iterable of decoded chunks (SSE streams included). Non-2xx
 * responses throw ProviderRequestError with a SAFE category.
 */
export async function providerFetchStream(options: ProviderFetchOptions): Promise<ProviderStreamResponse> {
  const url = validateUrl(options.url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('provider timeout')), options.timeoutMs ?? 120_000);
  const onExternalAbort = () => controller.abort(new Error('canceled'));
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? 'POST',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', onExternalAbort);
    const code: ProviderErrorCode = options.signal?.aborted ? 'canceled' : 'network_error';
    throw new ProviderRequestError(code, err instanceof Error && err.message === 'canceled' ? undefined : undefined);
  }

  if (!res.ok) {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', onExternalAbort);
    // Drain a small part of the body for classification only — never returned raw.
    let firstBytes = '';
    try {
      const reader = res.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        if (value) firstBytes = Buffer.from(value).toString('utf8').slice(0, 200);
        reader.cancel().catch(() => {});
      }
    } catch { /* classification only */ }
    void firstBytes;
    const { classifyHttpFailure } = await import('./provider-types.js');
    const code = classifyHttpFailure(res.status, url.host);
    // The status code itself is safe and actionable; response bodies never are.
    throw new ProviderRequestError(code, providerFailureMessage(res.status));
  }

  if (!res.body) {
    clearTimeout(timeoutId);
    throw new ProviderRequestError('bad_response');
  }

  const decoder = new TextDecoder();
  const signal = options.signal;
  async function* iterate(): AsyncGenerator<string, void, unknown> {
    try {
      const reader = res.body!.getReader();
      try {
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          totalBytes += value.byteLength;
          // Bound the entire response, not each individual TCP chunk.
          if (totalBytes > MAX_RESPONSE_BYTES) {
            throw new ProviderRequestError('bad_response', 'Provider response exceeded the size budget');
          }
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) yield chunk;
        }
        const trailing = decoder.decode();
        if (trailing) yield trailing;
      } finally {
        reader.releaseLock();
      }
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw new ProviderRequestError('canceled');
      }
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError('network_error');
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return { status: res.status, body: iterate() };
}

/** Non-streaming provider request (model listing, connection tests). */
export async function providerFetchJson<T>(options: ProviderFetchOptions): Promise<T> {
  const url = validateUrl(options.url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('provider timeout')), options.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) {
      const { classifyHttpFailure } = await import('./provider-types.js');
      const code = classifyHttpFailure(res.status, url.host);
      throw new ProviderRequestError(code, providerFailureMessage(res.status));
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new ProviderRequestError('bad_response', 'Provider response too large');
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    if (err instanceof ProviderRequestError) throw err;
    if (err instanceof SyntaxError) throw new ProviderRequestError('bad_response');
    if (options.signal?.aborted) throw new ProviderRequestError('canceled');
    if (err instanceof Error && err.message === 'provider timeout') throw new ProviderRequestError('timeout');
    throw new ProviderRequestError('network_error');
  } finally {
    clearTimeout(timeoutId);
  }
}
