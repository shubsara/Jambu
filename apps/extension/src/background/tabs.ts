/**
 * Tab observation — the privacy boundary (CLAUDE.md §9, decision D66).
 *
 * This is where a full URL exists, and it is the only place it is allowed to.
 * Each handler reduces it to a hostname immediately and lets the URL fall out
 * of scope. Nothing downstream of `trackDomain` ever receives it: not the open
 * session, not the buffer, not the network, not a log line.
 *
 * Nothing here logs at all, deliberately. A stray debug line naming a URL
 * would break the product's central promise more effectively than any bug.
 */
import { domainFromUrl } from '../lib/domain.js';
import { trackDomain } from './activity-tracker.js';
import { maybeFlush } from './flush.js';

/**
 * Note the tab the user has moved to.
 *
 * Takes the URL and returns nothing derived from it but a decision, so a
 * caller cannot accidentally retain it.
 */
export async function noteActiveUrl(url: string | undefined, now: Date): Promise<void> {
  const domain = domainFromUrl(url);
  const buffered = await trackDomain(domain, now);
  if (buffered) {
    await maybeFlush();
  }
}

export function registerTabListeners(tabsApi = globalThis.chrome?.tabs): void {
  if (tabsApi === undefined) {
    return;
  }

  tabsApi.onActivated?.addListener((info) => {
    void tabsApi.get?.(info.tabId).then((tab) => {
      void noteActiveUrl(tab?.url, new Date());
    });
  });

  tabsApi.onUpdated?.addListener((_tabId, changeInfo, tab) => {
    // Only a navigation matters; a title or favicon change is not new work.
    if (changeInfo.url === undefined || tab.active !== true) {
      return;
    }
    void noteActiveUrl(changeInfo.url, new Date());
  });
}
