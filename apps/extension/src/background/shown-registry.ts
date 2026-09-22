/**
 * Shown-intervention registry (decision D74).
 *
 * Both D4 paths can surface the same intervention: the sync response and the
 * fallback poll. Without this the user would see the same card twice.
 *
 * Entries are pruned once past the intervention's expiry, so the registry
 * cannot grow without bound. The server lifecycle remains authoritative — this
 * only prevents a double render.
 */

const REGISTRY_KEY = 'intervention.shown';

/** Matches the server-side expiry window (decision D50). */
export const SHOWN_RETENTION_MINUTES = 30;

interface ShownEntry {
  readonly id: string;
  /** Epoch milliseconds when this entry may be forgotten. */
  readonly forgetAfter: number;
}

const memoryFallback = new Map<string, unknown>();

function area(): chrome.storage.StorageArea | null {
  return globalThis.chrome?.storage?.local ?? null;
}

async function read(): Promise<ShownEntry[]> {
  const store = area();
  if (store === null) {
    return (memoryFallback.get(REGISTRY_KEY) as ShownEntry[] | undefined) ?? [];
  }
  const result = (await store.get(REGISTRY_KEY)) as Record<string, unknown>;
  const value = result[REGISTRY_KEY];
  return Array.isArray(value) ? (value as ShownEntry[]) : [];
}

async function write(entries: readonly ShownEntry[]): Promise<void> {
  const store = area();
  if (store === null) {
    memoryFallback.set(REGISTRY_KEY, [...entries]);
    return;
  }
  await store.set({ [REGISTRY_KEY]: entries });
}

/** Drop anything past its retention window. */
function prune(entries: readonly ShownEntry[], now: Date): ShownEntry[] {
  return entries.filter((entry) => entry.forgetAfter > now.getTime());
}

export async function hasBeenShown(id: string, now: Date): Promise<boolean> {
  const live = prune(await read(), now);
  return live.some((entry) => entry.id === id);
}

export async function markShown(id: string, now: Date): Promise<void> {
  const live = prune(await read(), now);
  if (live.some((entry) => entry.id === id)) {
    return;
  }
  live.push({ id, forgetAfter: now.getTime() + SHOWN_RETENTION_MINUTES * 60_000 });
  await write(live);
}

/** Forget an intervention once it has been answered. */
export async function forgetShown(id: string, now: Date): Promise<void> {
  const live = prune(await read(), now).filter((entry) => entry.id !== id);
  await write(live);
}

export async function shownCount(now: Date): Promise<number> {
  return prune(await read(), now).length;
}
