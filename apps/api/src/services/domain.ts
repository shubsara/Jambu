/**
 * Domain normalisation (decision D22).
 *
 * The privacy boundary of the whole product runs through this file.
 * CLAUDE.md §9: Jambu knows *how long* the user worked, not *what* they
 * worked on. §11: "Do not store page URLs when the domain is sufficient."
 *
 * So the API accepts a bare hostname and nothing else. Anything carrying a
 * scheme, path, query, fragment, credentials or port is **rejected**, not
 * stripped (decision D23) — silently stripping would hide a client that is
 * actively leaking browsing data, which is the failure we most need to see.
 *
 * Per D22 the normalised hostname is stored as given: `foo.co.uk` is not
 * reduced to a registrable domain, because doing that correctly needs the
 * Public Suffix List and doing it naively is wrong.
 */

/** Why a submitted domain was refused. Never contains the offending value. */
export type DomainRejection =
  | 'empty'
  | 'contains_scheme'
  | 'contains_path'
  | 'contains_query'
  | 'contains_fragment'
  | 'contains_credentials'
  | 'contains_port'
  | 'contains_whitespace'
  | 'invalid_hostname'
  | 'too_long';

export type DomainResult =
  | { readonly ok: true; readonly domain: string }
  | { readonly ok: false; readonly reason: DomainRejection };

/** Longest permissible hostname, per DNS. */
const MAX_HOSTNAME_LENGTH = 253;

/**
 * Labels separated by dots; each 1-63 characters of letters, digits or
 * hyphens, not starting or ending with a hyphen. Punycode (`xn--`) passes,
 * so internationalised domains are accepted in their encoded form.
 */
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

/**
 * Normalise a hostname, or explain why it is unacceptable.
 *
 * The rejection reason never echoes the input, so a leaked URL cannot reach a
 * log line or an error body by way of the error message itself.
 */
export function normalizeDomain(raw: string): DomainResult {
  const value = raw.trim();

  if (value.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (/\s/.test(value)) {
    return { ok: false, reason: 'contains_whitespace' };
  }
  if (value.includes('://')) {
    return { ok: false, reason: 'contains_scheme' };
  }
  // A trailing `:1234` is a port; any other colon is a scheme separator.
  // Ports are checked first because `notion.so:443` also matches the shape of
  // `scheme:` and the reason code should say what is actually wrong.
  if (/:\d+$/.test(value)) {
    return { ok: false, reason: 'contains_port' };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return { ok: false, reason: 'contains_scheme' };
  }
  if (value.includes('@')) {
    return { ok: false, reason: 'contains_credentials' };
  }
  if (value.includes('?')) {
    return { ok: false, reason: 'contains_query' };
  }
  if (value.includes('#')) {
    return { ok: false, reason: 'contains_fragment' };
  }
  if (value.includes('/')) {
    return { ok: false, reason: 'contains_path' };
  }
  if (value.includes(':')) {
    // Any remaining colon: not part of a hostname, and usually a sign that a
    // URL was pasted in rather than a hostname extracted.
    return { ok: false, reason: 'contains_port' };
  }

  // Lowercase, and drop the trailing dot of a fully-qualified name so
  // `notion.so.` and `notion.so` cannot become two different domains.
  const normalized = value.toLowerCase().replace(/\.$/, '');

  if (normalized.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (normalized.length > MAX_HOSTNAME_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  if (!HOSTNAME_PATTERN.test(normalized)) {
    return { ok: false, reason: 'invalid_hostname' };
  }

  return { ok: true, domain: normalized };
}
