/**
 * May Jambu observe this person yet? (decision D93)
 *
 * Signing in is not consent to be observed; finishing onboarding is. Every
 * activity listener asks here first, so a user who skipped onboarding has a
 * working account and a Jambu that records nothing at all (resolution A5).
 *
 * The server is authoritative (D86). This reads the cached echo of
 * `onboardingCompletedAt` so a tab event costs no network call, and **fails
 * closed**: an unreadable or missing cache means "do not track", never
 * "probably fine".
 */
import { hasSession, readCachedOnboardingCompletedAt } from '../lib/storage.js';

export async function mayTrack(): Promise<boolean> {
  if (!(await hasSession())) {
    return false;
  }
  return (await readCachedOnboardingCompletedAt()) !== null;
}

/**
 * Open one of the extension's own pages in a tab.
 *
 * `chrome.tabs.create` needs no `tabs` permission, so this does not widen the
 * manifest (D3 minimization). Extracted from `openOnboarding` so the settings
 * page can reuse the one navigation path already proven to work.
 */
export async function openExtensionPage(
  path: string,
  tabs = globalThis.chrome?.tabs,
  runtime = globalThis.chrome?.runtime,
): Promise<void> {
  const url = runtime?.getURL?.(path);
  if (tabs?.create === undefined || url === undefined) {
    return;
  }
  await tabs.create({ url });
}

/** Open the onboarding page (decision D85). */
export async function openOnboarding(
  tabs = globalThis.chrome?.tabs,
  runtime = globalThis.chrome?.runtime,
): Promise<void> {
  await openExtensionPage('onboarding/index.html', tabs, runtime);
}
