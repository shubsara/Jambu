/**
 * Domain extraction (decision D66).
 *
 * This is the narrowest and most important piece of code in the extension.
 * CLAUDE.md §9: Jambu knows *how long* the user has been working, not *what*
 * they are working on.
 *
 * The rule the whole privacy promise rests on: a full URL is passed in, a
 * hostname comes out, and the URL is never returned, stored or logged. Callers
 * must invoke this inside the tab-event handler and let the URL go out of
 * scope there — nothing downstream ever sees it.
 */

/** Schemes that describe a page the user is actually working on. */
const TRACKABLE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Reduce a URL to its hostname, or `null` when there isn't a meaningful one.
 *
 * `null` is not a failure: `chrome://`, `chrome-extension://`, `about:` and
 * `file:` pages are still real working time, and decision D66 records them as
 * a session with no domain rather than discarding the time.
 *
 * The returned hostname is lowercased with any trailing dot removed, matching
 * the normalisation the API applies (decision D22), so `NOTION.SO.` and
 * `notion.so` cannot become two different domains.
 */
export function domainFromUrl(url: string | undefined | null): string | null {
  if (url === undefined || url === null || url.length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL we can reason about. The time still counts; the address does not.
    return null;
  }

  if (!TRACKABLE_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return hostname.length === 0 ? null : hostname;
}
