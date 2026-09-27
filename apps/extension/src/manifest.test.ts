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
  icons?: Record<string, string>;
  action?: { default_popup?: string; default_icon?: Record<string, string> };
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

/**
 * Extension icons (decisions D108-D110).
 *
 * Before these existed the manifest declared no icon at all and Chrome drew a
 * generated grey placeholder. The checks mirror the `options_ui` guards above,
 * and for the same reason: a manifest can name a file the build never emits,
 * or name a 16 that is really a 128, and Chrome says nothing either way.
 */
describe('icons (decisions D108-D110)', () => {
  const SIZES = ['16', '32', '48', '128'] as const;

  /** Width and height straight out of the PNG IHDR chunk. */
  function pngSize(file: string): { width: number; height: number } {
    const bytes = readFileSync(file);
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  function sourceOf(path: string): string {
    return fileURLToPath(new URL(`../public/${path}`, import.meta.url));
  }

  it('declares every size Chrome asks for', () => {
    expect(Object.keys(manifest.icons ?? {})).toEqual([...SIZES]);
  });

  it('gives the toolbar action the same set', () => {
    // `icons` and `action.default_icon` are not interchangeable: the first is
    // the installed extension, the second is the button in the toolbar.
    expect(Object.keys(manifest.action?.default_icon ?? {})).toEqual([...SIZES]);
    expect(manifest.action?.default_icon).toEqual(manifest.icons);
  });

  it('points at files that actually exist', () => {
    for (const size of SIZES) {
      expect(existsSync(sourceOf(manifest.icons?.[size] ?? ''))).toBe(true);
    }
  });

  it('ships a PNG of the size it claims', () => {
    for (const size of SIZES) {
      const { width, height } = pngSize(sourceOf(manifest.icons?.[size] ?? ''));
      expect({ size, width, height }).toEqual({
        size,
        width: Number(size),
        height: Number(size),
      });
    }
  });

  it('keeps the transparent corners (decision D108)', () => {
    // Chrome does not mask extension icons. Without an alpha channel the
    // rounded corners render as opaque notches on a dark theme.
    for (const size of SIZES) {
      const bytes = readFileSync(sourceOf(manifest.icons?.[size] ?? ''));
      // IHDR colour type, byte 25: 6 = truecolour with alpha.
      expect(bytes.readUInt8(25)).toBe(6);
    }
  });

  it('adds icons without adding a permission', () => {
    expect(manifest.permissions).toEqual([
      'storage',
      'idle',
      'alarms',
      'scripting',
      'notifications',
    ]);
  });
});
