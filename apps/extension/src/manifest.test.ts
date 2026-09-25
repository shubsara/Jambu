/**
 * Manifest and permission snapshot (decisions D3, D55).
 *
 * Decision D55 chose phase-specific permissions: the shipped extension asks
 * only for what the code it contains actually uses. P8 uses `storage` and
 * nothing else, so that is all it may declare.
 *
 * Widening this list is a reviewed event. If a later phase needs `alarms`,
 * `idle`, `scripting`, `notifications` or `<all_urls>`, this test fails first
 * and the widening is discussed rather than absorbed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../public/manifest.json', import.meta.url)),
    'utf8',
  ),
) as {
  manifest_version: number;
  permissions?: string[];
  host_permissions?: string[];
  background?: { service_worker?: string; type?: string };
  action?: { default_popup?: string };
  options_ui?: { page?: string; open_in_tab?: boolean };
  content_scripts?: unknown[];
  web_accessible_resources?: unknown[];
};

describe('permission snapshot (decision D55)', () => {
  it('requests exactly the permissions P8-P10 use', () => {
    // storage: P8 auth + P9 buffer. idle + alarms: P9 (D62, D64).
    // scripting + notifications: P10 Care Card and its fallback (D3, D67).
    expect(manifest.permissions).toEqual([
      'storage',
      'idle',
      'alarms',
      'scripting',
      'notifications',
    ]);
  });

  it('requests host access for domain attribution only (decision D60)', () => {
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });

  it('now matches ARCHITECTURE.md §9.3 exactly, with no further widening planned', () => {
    expect(manifest.permissions).toEqual([
      'storage',
      'idle',
      'alarms',
      'scripting',
      'notifications',
    ]);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });

  it('never requests tabs (decision D3)', () => {
    expect(manifest.permissions).not.toContain('tabs');
    expect(JSON.stringify(manifest)).not.toContain('"tabs"');
  });

  it('requests none of the permissions ARCHITECTURE.md §9.3 rules out', () => {
    for (const forbidden of [
      'history',
      'webRequest',
      'cookies',
      'downloads',
      'clipboardRead',
      'clipboardWrite',
      'bookmarks',
      'management',
      'debugger',
      'nativeMessaging',
    ]) {
      expect(manifest.permissions ?? []).not.toContain(forbidden);
    }
  });
});

describe('manifest validity', () => {
  it('is Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('declares the service worker as an ES module', () => {
    expect(manifest.background?.service_worker).toBe('background/service-worker.js');
    expect(manifest.background?.type).toBe('module');
  });

  it('points the action at the popup', () => {
    expect(manifest.action?.default_popup).toBe('popup/index.html');
  });

  /**
   * Regression guard for the P13 Settings blocker.
   *
   * `chrome.runtime.openOptionsPage()` fails when `options_ui` is absent or
   * points at a file that does not exist, and the popup's click then produced
   * no response at all. Nothing asserted either fact, so nothing caught it.
   */
  it('declares the options page (decision D97)', () => {
    expect(manifest.options_ui?.page).toBe('options/index.html');
    expect(manifest.options_ui?.open_in_tab).toBe(true);
  });

  it('points options_ui at a page that actually exists', () => {
    // A manifest can name a file the build never emits; Chrome only complains
    // at click time, silently, which is exactly how this went unnoticed.
    const page = manifest.options_ui?.page ?? '';
    const source = fileURLToPath(new URL(`../src/${page}`, import.meta.url));
    expect(existsSync(source)).toBe(true);
  });

  it('adds options_ui without adding a permission', () => {
    // `options_ui` is a manifest key, not a permission (D3 minimization).
    expect(manifest.permissions).toEqual([
      'storage',
      'idle',
      'alarms',
      'scripting',
      'notifications',
    ]);
  });

  it('declares no static content scripts - the card is injected on demand', () => {
    // Decision D3: injection happens only at the moment of an intervention,
    // which is narrower than a static all-frames content script.
    expect(manifest.content_scripts).toBeUndefined();
  });

  it('exposes no web-accessible resources', () => {
    // The card's CSS is read by the extension and passed to the injected
    // script, never fetched by the page - so nothing needs exposing, and no
    // page can detect the extension by probing for its files.
    expect(manifest.web_accessible_resources).toBeUndefined();
  });
});
