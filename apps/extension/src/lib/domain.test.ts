/**
 * Domain extraction — the privacy boundary (CLAUDE.md §9, decision D66).
 *
 * The rule under test: a URL goes in, a hostname comes out, and nothing that
 * could identify the page survives.
 */
import { describe, expect, it } from 'vitest';

import { domainFromUrl } from './domain.js';

describe('http and https produce a hostname', () => {
  it('extracts the hostname and discards everything else', () => {
    expect(domainFromUrl('https://notion.so/salary-review?q=secret#draft')).toBe(
      'notion.so',
    );
    expect(domainFromUrl('http://github.com/user/private-repo')).toBe('github.com');
  });

  it('keeps subdomains, matching the API normalisation (decision D22)', () => {
    expect(domainFromUrl('https://www.notion.so/page')).toBe('www.notion.so');
    expect(domainFromUrl('https://user.github.io/blog')).toBe('user.github.io');
    expect(domainFromUrl('https://foo.co.uk/x')).toBe('foo.co.uk');
  });

  it('lowercases and drops a trailing dot', () => {
    expect(domainFromUrl('https://NOTION.SO./page')).toBe('notion.so');
  });

  it('ignores credentials and ports, which are not part of a domain', () => {
    expect(domainFromUrl('https://user:pass@notion.so:8443/page')).toBe('notion.so');
  });
});

describe('untrackable schemes produce no domain (decision D66)', () => {
  it('returns null rather than a fabricated domain', () => {
    for (const url of [
      'chrome://extensions',
      'chrome-extension://abcdef/popup.html',
      'about:blank',
      'file:///Users/someone/private.pdf',
      'data:text/html,hello',
    ]) {
      expect(domainFromUrl(url)).toBeNull();
    }
  });

  it('returns null for absent or unparseable input', () => {
    expect(domainFromUrl(undefined)).toBeNull();
    expect(domainFromUrl(null)).toBeNull();
    expect(domainFromUrl('')).toBeNull();
    expect(domainFromUrl('not a url')).toBeNull();
  });
});

describe('nothing identifying the page survives', () => {
  it('never returns a path, query or fragment', () => {
    const url = 'https://notion.so/secret-doc?token=super-secret-value#section';
    const domain = domainFromUrl(url);

    expect(domain).toBe('notion.so');
    expect(domain).not.toContain('secret-doc');
    expect(domain).not.toContain('super-secret-value');
    expect(domain).not.toMatch(/[/?#]/);
  });

  it('returns nothing longer than the hostname for any URL shape', () => {
    for (const url of [
      'https://a.example.com/very/deep/path/with/segments',
      'https://a.example.com/?a=1&b=2&c=3',
      'https://a.example.com/#/client/side/route',
    ]) {
      expect(domainFromUrl(url)).toBe('a.example.com');
    }
  });
});
