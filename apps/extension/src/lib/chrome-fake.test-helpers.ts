/**
 * A minimal `chrome.storage` double.
 *
 * Real enough to catch the thing that matters: that the access token goes to
 * `session` and the refresh token to `local`, and that clearing one does not
 * clear the other.
 */
export interface FakeAreas {
  readonly local: Map<string, unknown>;
  readonly session: Map<string, unknown>;
}

function area(store: Map<string, unknown>): chrome.storage.StorageArea {
  return {
    get: async (key: string) => {
      const value = store.get(key);
      return value === undefined ? {} : { [key]: value };
    },
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) store.set(key, value);
    },
    remove: async (keys: string[]) => {
      for (const key of keys) store.delete(key);
    },
  } as unknown as chrome.storage.StorageArea;
}

/** Install the double and return the backing maps. */
export function installFakeChrome(): FakeAreas {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: { onMessage: { addListener: () => undefined } },
  };
  return { local, session };
}

/**
 * Simulate MV3 terminating the service worker: everything in memory is lost,
 * `chrome.storage.session` survives (it is browser-held, not worker-held), and
 * `chrome.storage.local` survives on disk.
 */
export function simulateWorkerRestart(areas: FakeAreas): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area(areas.local), session: area(areas.session) },
    runtime: { onMessage: { addListener: () => undefined } },
  };
}

/** Simulate a full browser restart: session storage is cleared, local is not. */
export function simulateBrowserRestart(areas: FakeAreas): void {
  areas.session.clear();
  simulateWorkerRestart(areas);
}

export function uninstallFakeChrome(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}
