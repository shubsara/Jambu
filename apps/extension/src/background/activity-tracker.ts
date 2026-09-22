/**
 * Activity session tracking (CLAUDE.md §11, decisions D61, D62, D66).
 *
 * A session is a stretch of time on one domain. It closes when the domain
 * changes (decision D61) or when the user goes idle, and what is recorded is a
 * start, an end, a duration and at most a hostname.
 *
 * The open session lives in `chrome.storage`, not module scope — MV3 kills an
 * idle worker and a session held in memory would vanish with it.
 *
 * Note on D6: the >=10-minute continuity rule is **not** implemented here. It
 * belongs to P5 derivation, which reads the stored sessions and folds them
 * into runs. Re-implementing it in the tracker would create a second
 * definition that could drift.
 */
import { MAX_ACTIVE_SECONDS_PER_SESSION } from '@jambu/shared-types';

import { appendSession, type BufferedSession } from './activity-buffer.js';

/** The session currently open, as persisted. */
interface OpenSession {
  readonly clientSessionId: string;
  readonly startedAt: string;
  readonly domain: string | null;
}

const OPEN_SESSION_KEY = 'activity.openSession';

/** Sessions shorter than this are noise from rapid tab switching. */
const MINIMUM_SESSION_SECONDS = 1;

const memoryFallback = new Map<string, unknown>();

function area(): chrome.storage.StorageArea | null {
  return globalThis.chrome?.storage?.local ?? null;
}

async function readOpenSession(): Promise<OpenSession | null> {
  const store = area();
  if (store === null) {
    return (memoryFallback.get(OPEN_SESSION_KEY) as OpenSession | undefined) ?? null;
  }
  const result = (await store.get(OPEN_SESSION_KEY)) as Record<string, unknown>;
  return (result[OPEN_SESSION_KEY] as OpenSession | undefined) ?? null;
}

async function writeOpenSession(session: OpenSession | null): Promise<void> {
  const store = area();
  if (store === null) {
    if (session === null) memoryFallback.delete(OPEN_SESSION_KEY);
    else memoryFallback.set(OPEN_SESSION_KEY, session);
    return;
  }
  if (session === null) {
    await store.remove([OPEN_SESSION_KEY]);
    return;
  }
  await store.set({ [OPEN_SESSION_KEY]: session });
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Close the open session, if any, and buffer it.
 *
 * Returns whether anything was buffered, so callers can decide about syncing
 * without reading the buffer again.
 */
export async function closeSession(now: Date): Promise<boolean> {
  const open = await readOpenSession();
  if (open === null) {
    return false;
  }

  await writeOpenSession(null);

  const startedMs = Date.parse(open.startedAt);
  const activeSeconds = Math.floor((now.getTime() - startedMs) / 1000);

  // Too short to mean anything, or a clock that moved backwards.
  if (activeSeconds < MINIMUM_SESSION_SECONDS) {
    return false;
  }

  // The API rejects anything longer than a day (decision D25). A session that
  // long means the worker slept through a suspend, so it is clamped by being
  // dropped rather than sent and refused forever.
  if (activeSeconds > MAX_ACTIVE_SECONDS_PER_SESSION) {
    return false;
  }

  const session: BufferedSession = {
    clientSessionId: open.clientSessionId,
    startedAt: open.startedAt,
    endedAt: now.toISOString(),
    activeSeconds,
    domain: open.domain,
  };

  await appendSession(session);
  return true;
}

/** Open a session on a domain. Any existing session must already be closed. */
export async function openSession(domain: string | null, now: Date): Promise<void> {
  await writeOpenSession({
    clientSessionId: newId(),
    startedAt: now.toISOString(),
    domain,
  });
}

/**
 * Record that the user is now on `domain`.
 *
 * Decision D61: a domain change closes the current session and opens a new
 * one, so every stored session carries exactly one domain. Staying on the same
 * domain extends the open session rather than churning rows.
 *
 * Returns whether a session was buffered as a result.
 */
export async function trackDomain(domain: string | null, now: Date): Promise<boolean> {
  const open = await readOpenSession();

  if (open !== null && open.domain === domain) {
    return false;
  }

  const buffered = await closeSession(now);
  await openSession(domain, now);
  return buffered;
}

/** Exposed for tests and for the idle handler. */
export async function currentSession(): Promise<OpenSession | null> {
  return readOpenSession();
}

export { OPEN_SESSION_KEY, MINIMUM_SESSION_SECONDS };
