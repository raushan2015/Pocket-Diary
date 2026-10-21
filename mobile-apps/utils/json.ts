/** Safe JSON helpers — never throw; malformed values fall back. */

export function safeJsonArray<T>(raw: unknown, fallback: T[] = []): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Deep-equality via canonical JSON — used by sync dedupe checks. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
