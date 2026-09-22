/**
 * The local activity buffer (decisions D64, D65; CLAUDE.md §25, §26).
 *
 * Everything lives in `chrome.storage`, never module scope: MV3 terminates an
 * idle service worker within about thirty seconds, and a buffer held in memory
 * would be lost with it. Every mutation is a read-modify-write, which is the
 * price of surviving termination.
 *
 * The buffer holds **aggregated sessions only** — start, end, duration and at
 * most a hostname. No URL, page title or page content ever reaches it.
 */
import { MAX_ACTIVITY_SESSIONS_PER_BATCH } from '@jambu/shared-types';

/** A completed session, in the shape `POST /api/activity/session` accepts. */
export interface BufferedSession {
  readonly clientSessionId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly activeSeconds: number;
  /** Registrable hostname, or null for an untrackable scheme (decision D66). */
  readonly domain: string | null;
}

/**
 * Decision D65 — the cap matches the API's batch maximum, so a full buffer is
 * always expressible as exactly one request.
 */
export const BUFFER_CAPACITY = MAX_ACTIVITY_SESSIONS_PER_BATCH;

/** Decision D64 — flush once this many sessions are waiting. */
export const FLUSH_THRESHOLD = 20;

const BUFFER_KEY = 'activity.buffer';

function area(): chrome.storage.StorageArea | null {
  return globalThis.chrome?.storage?.local ?? null;
}

const memoryFallback = new Map<string, unknown>();

async function read(): Promise<BufferedSession[]> {
  const store = area();
  if (store === null) {
    return (memoryFallback.get(BUFFER_KEY) as BufferedSession[] | undefined) ?? [];
  }
  const result = (await store.get(BUFFER_KEY)) as Record<string, unknown>;
  const value = result[BUFFER_KEY];
  return Array.isArray(value) ? (value as BufferedSession[]) : [];
}

async function write(sessions: readonly BufferedSession[]): Promise<void> {
  const store = area();
  if (store === null) {
    memoryFallback.set(BUFFER_KEY, [...sessions]);
    return;
  }
  await store.set({ [BUFFER_KEY]: sessions });
}

/**
 * Append a session, evicting the oldest if the buffer is full.
 *
 * Eviction is the only way P9 loses data, and only once the backlog exceeds
 * {@link BUFFER_CAPACITY} unsynced sessions — far beyond the 30-minute outage
 * the acceptance criteria require to survive intact.
 */
export async function appendSession(session: BufferedSession): Promise<void> {
  const buffer = await read();
  buffer.push(session);

  const overflow = buffer.length - BUFFER_CAPACITY;
  await write(overflow > 0 ? buffer.slice(overflow) : buffer);
}

export async function readBuffer(): Promise<BufferedSession[]> {
  return read();
}

export async function bufferSize(): Promise<number> {
  return (await read()).length;
}

/**
 * Remove sessions that have been dealt with, matched by idempotency key.
 *
 * Matching by key rather than truncating by count matters: sessions can be
 * appended while a sync is in flight, and a count-based removal would discard
 * them unsent.
 */
export async function removeSessions(clientSessionIds: readonly string[]): Promise<void> {
  const settled = new Set(clientSessionIds);
  const remaining = (await read()).filter(
    (session) => !settled.has(session.clientSessionId),
  );
  await write(remaining);
}

/** Whether the buffer has reached the flush threshold (decision D64). */
export async function shouldFlush(): Promise<boolean> {
  return (await read()).length >= FLUSH_THRESHOLD;
}

export async function clearBuffer(): Promise<void> {
  await write([]);
}
