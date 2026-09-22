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
import { readFileSync } from 'node:fs';
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
  content_scripts?: unknown[];
  web_accessible_resources?: unknown[];
};

describe('permission snapshot (decision D55)', () => {
  it('requests exactly the permissions P8-P9 use', () => {
    // storage: P8 auth + P9 buffer. idle + alarms: P9 (decisions D62, D64).
    expect(manifest.permissions).toEqual(['storage', 'idle', 'alarms']);
  });

  it('requests host access for domain attribution only (decision D60)', () => {
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });

  it('does not request permissions that later phases will need', () => {
    // scripting and notifications arrive with the Care Card in P10.
    for (const later of ['scripting', 'notifications']) {
      expect(manifest.permissions).not.toContain(later);
    }
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

  it('declares no content scripts yet (the Care Card is P10)', () => {
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it('holds host access without the means to inject, until P10', () => {
    // <all_urls> is here for reading the active tab's domain. Injection needs
    // `scripting`, which P9 deliberately does not request.
    expect(manifest.host_permissions).toContain('<all_urls>');
    expect(manifest.permissions).not.toContain('scripting');
  });
});
