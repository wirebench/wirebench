import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  preferencesSchema,
  resetPreferences,
} from '../../../src/project/preferences.js';

describe('DEFAULT_PREFERENCES', () => {
  it('carries the documented defaults', () => {
    expect(DEFAULT_PREFERENCES.http.userAgent).toBe('Wirebench/0.1');
    expect(DEFAULT_PREFERENCES.http.socketTimeoutMs).toBe(60_000);
    expect(DEFAULT_PREFERENCES.editor.fontSize).toBe(13);
    expect(DEFAULT_PREFERENCES.editor.tabSize).toBe(3);
    expect(DEFAULT_PREFERENCES.ui.historyCap).toBe(1000);
    expect(DEFAULT_PREFERENCES.ssl.trustAll).toBe(false);
    expect(DEFAULT_PREFERENCES.shortcuts).toEqual({});
  });
});

describe('mergePreferences', () => {
  it('fills every section from the defaults', () => {
    expect(mergePreferences({})).toEqual(DEFAULT_PREFERENCES);
  });

  it('merges one field without dropping its siblings', () => {
    const merged = mergePreferences({ http: { userAgent: 'Custom/1' } });
    expect(merged.http.userAgent).toBe('Custom/1');
    expect(merged.http.socketTimeoutMs).toBe(DEFAULT_PREFERENCES.http.socketTimeoutMs);
  });

  it('merges the nested default layout', () => {
    const merged = mergePreferences({ ui: { defaultLayout: { mode: 'tabs' } } });
    expect(merged.ui.defaultLayout).toEqual({ orientation: 'side-by-side', mode: 'tabs' });
  });

  it('ignores unknown keys and unusable values rather than failing', () => {
    const merged = mergePreferences({ nonsense: true, editor: { tabSize: 2 } });
    expect(merged.editor.tabSize).toBe(2);
    expect(merged).not.toHaveProperty('nonsense');
  });

  it('falls back to the defaults for a document of the wrong shape', () => {
    expect(mergePreferences('not a document')).toEqual(DEFAULT_PREFERENCES);
    expect(mergePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it('pins trustAll to false whatever the document claims', () => {
    expect(mergePreferences({ ssl: { trustAll: true } }).ssl.trustAll).toBe(false);
  });

  it('loses only the section a bad field is in, keeping every other section of the same patch', () => {
    const merged = mergePreferences({
      http: { userAgent: 'Custom/1' },
      // `sampleValues` must be a boolean; this section fails to parse on its own.
      wsdl: { sampleValues: 'yes' },
    });
    expect(merged.http.userAgent).toBe('Custom/1');
    expect(merged.wsdl).toEqual(DEFAULT_PREFERENCES.wsdl);
  });

  it('loses only the malformed section, not sections that come after it', () => {
    const merged = mergePreferences({
      proxy: { port: 'not-a-number' },
      editor: { tabSize: 5 },
    });
    expect(merged.proxy).toEqual(DEFAULT_PREFERENCES.proxy);
    expect(merged.editor.tabSize).toBe(5);
  });

  it('merges onto a given base rather than the defaults', () => {
    const base = mergePreferences({ http: { userAgent: 'Base/1' } });
    expect(mergePreferences({ editor: { tabSize: 4 } }, base).http.userAgent).toBe('Base/1');
  });

  it('accepts a document it previously produced', () => {
    const parsed = preferencesSchema.safeParse({ version: 1, ...DEFAULT_PREFERENCES });
    expect(parsed.success).toBe(true);
  });
});

describe('resetPreferences', () => {
  it('resets one section, leaving the others alone', () => {
    const current = mergePreferences({ editor: { tabSize: 8 }, http: { userAgent: 'Keep/1' } });
    const reset = resetPreferences(current, 'editor');
    expect(reset.editor).toEqual(DEFAULT_PREFERENCES.editor);
    expect(reset.http.userAgent).toBe('Keep/1');
  });

  it('resets everything when no section is named', () => {
    expect(resetPreferences(mergePreferences({ editor: { tabSize: 8 } }))).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('network preference defaults', () => {
  it('starts with no proxy, no extra anchors, a TLS 1.2 floor and HTTP/2 off', () => {
    expect(DEFAULT_PREFERENCES.proxy).toEqual({ mode: 'none', excludes: [] });
    expect(DEFAULT_PREFERENCES.ssl).toEqual({ minVersion: 'TLSv1.2', trustAll: false });
    expect(DEFAULT_PREFERENCES.http.allowH2).toBe(false);
  });

  it('keeps the manual proxy fields, including the passwordRef, across a merge', () => {
    const merged = mergePreferences({
      proxy: {
        mode: 'manual',
        host: 'proxy.corp.test',
        port: 8080,
        username: 'u',
        passwordRef: 'ref-1',
        excludes: ['*.internal'],
      },
    });
    expect(merged.proxy).toEqual({
      mode: 'manual',
      host: 'proxy.corp.test',
      port: 8080,
      username: 'u',
      passwordRef: 'ref-1',
      excludes: ['*.internal'],
    });
  });

  it('keeps the CA bundle path and the global keystore ref', () => {
    const merged = mergePreferences({ ssl: { caBundlePath: '/etc/corp/ca.pem', clientKeystoreRef: 'ks-1' } });
    expect(merged.ssl.caBundlePath).toBe('/etc/corp/ca.pem');
    expect(merged.ssl.clientKeystoreRef).toBe('ks-1');
    expect(merged.ssl.trustAll).toBe(false);
  });
});
