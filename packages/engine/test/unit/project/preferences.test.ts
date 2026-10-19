import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  describePreferenceLimit,
  mergePreferences,
  PREFERENCE_NUMBER_LIMITS,
  preferencesPatchProblems,
  preferencesSchema,
  resetPreferences,
  withAppUserAgent,
} from '../../../src/project/preferences.js';

describe('DEFAULT_PREFERENCES', () => {
  it('carries the documented defaults', () => {
    expect(DEFAULT_PREFERENCES.http.userAgent).toBe('Wirebench');
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

describe('secrets preferences', () => {
  it('defaults, reads and clamps secrets.sourceCacheSeconds', () => {
    const read = (value: number) =>
      mergePreferences({ secrets: { sourceCacheSeconds: value } }).secrets.sourceCacheSeconds;
    expect(DEFAULT_PREFERENCES.secrets.sourceCacheSeconds).toBe(300);
    expect(read(0)).toBe(0);
    expect(read(99999)).toBe(3600);
    expect(read(-5)).toBe(0);
    expect(read(12.6)).toBe(13);
  });
});

describe('ssh preferences (#571)', () => {
  it('defaults to no user, a 15 s keep-alive, a 20 s connect timeout, UTF-8 and xterm-256color', () => {
    expect(DEFAULT_PREFERENCES.ssh).toEqual({
      keepAlive: 15,
      connectTimeout: 20,
      charset: 'utf-8',
      term: 'xterm-256color',
    });
  });

  it('reads the user and both numbers, and clamps a number from disk into range', () => {
    expect(mergePreferences({ ssh: { user: 'alice', keepAlive: 0, connectTimeout: 5 } }).ssh).toEqual({
      user: 'alice',
      keepAlive: 0,
      connectTimeout: 5,
      charset: 'utf-8',
      term: 'xterm-256color',
    });
    expect(mergePreferences({ ssh: { keepAlive: 99_999, connectTimeout: 0 } }).ssh).toEqual({
      keepAlive: 3600,
      connectTimeout: 1,
      charset: 'utf-8',
      term: 'xterm-256color',
    });
  });

  it('reads the character set and terminal type (#427), and refuses a terminal type that is not a name', () => {
    expect(mergePreferences({ ssh: { charset: 'cp850', term: 'vt220' } }).ssh).toMatchObject({
      charset: 'cp850',
      term: 'vt220',
    });
    expect(preferencesPatchProblems({ ssh: { term: 'xterm 256' } })).not.toEqual([]);
  });

  it('refuses an out-of-range patch', () => {
    expect(preferencesPatchProblems({ ssh: { connectTimeout: 0 } })).toEqual([
      'ssh.connectTimeout must be a whole number from 1 to 600',
    ]);
    expect(preferencesPatchProblems({ ssh: { keepAlive: 1.5 } })).toEqual([
      'ssh.keepAlive must be a whole number from 0 to 3600',
    ]);
  });
});

describe('terminal preferences', () => {
  it('defaults to asking before a multi-line paste, not copying on select, reconnecting 10 times and suggesting', () => {
    expect(DEFAULT_PREFERENCES.terminal).toEqual({
      confirmMultilinePaste: true,
      confirmCloseSessions: true,
      copyOnSelect: false,
      autoReconnect: true,
      reconnectAttempts: 10,
      snippetSuggestions: true,
      highlightOutput: true,
      fontSize: 13,
      lineHeight: 1,
      colorScheme: 'app',
      sessionLogMaxMb: 500,
      sessionLogRaw: false,
      localShell: '',
    });
  });

  it('reads the booleans and ignores a value of the wrong type', () => {
    const merged = mergePreferences({
      terminal: { confirmMultilinePaste: false, copyOnSelect: true, autoReconnect: false, snippetSuggestions: false },
    });
    expect(merged.terminal).toEqual({
      confirmMultilinePaste: false,
      confirmCloseSessions: true,
      copyOnSelect: true,
      autoReconnect: false,
      reconnectAttempts: 10,
      snippetSuggestions: false,
      highlightOutput: true,
      fontSize: 13,
      lineHeight: 1,
      colorScheme: 'app',
      sessionLogMaxMb: 500,
      sessionLogRaw: false,
      localShell: '',
    });
    expect(mergePreferences({ terminal: { copyOnSelect: 'yes' } }).terminal).toEqual(DEFAULT_PREFERENCES.terminal);
  });

  it('a patch of one field leaves the other alone', () => {
    const merged = mergePreferences({ terminal: { copyOnSelect: true } });
    expect(merged.terminal.confirmMultilinePaste).toBe(true);
  });

  it('reads the session log cap and the raw switch, and clamps a cap read from disk', () => {
    const merged = mergePreferences({ terminal: { sessionLogMaxMb: 2000, sessionLogRaw: true } });
    expect(merged.terminal.sessionLogMaxMb).toBe(2000);
    expect(merged.terminal.sessionLogRaw).toBe(true);
    expect(mergePreferences({ terminal: { sessionLogMaxMb: 1 } }).terminal.sessionLogMaxMb).toBe(10);
    expect(mergePreferences({}).terminal.sessionLogRaw).toBe(false);
  });

  it('reads an older file without terminal.highlightOutput as on, and keeps it off once set', () => {
    expect(mergePreferences({ terminal: { copyOnSelect: true } }).terminal.highlightOutput).toBe(true);
    expect(mergePreferences({ terminal: { highlightOutput: false } }).terminal.highlightOutput).toBe(false);
  });

  it('reads an older file without terminal.snippetSuggestions as on', () => {
    expect(mergePreferences({ terminal: { copyOnSelect: true } }).terminal.snippetSuggestions).toBe(true);
    expect(mergePreferences({}).terminal.snippetSuggestions).toBe(true);
  });

  it('reads the font family, size, line height and colour scheme, clamping the numbers', () => {
    const merged = mergePreferences({
      terminal: { fontFamily: 'Fira Code', fontSize: 15, lineHeight: 1.3, colorScheme: 'solarized-dark' },
    });
    expect(merged.terminal).toMatchObject({
      fontFamily: 'Fira Code',
      fontSize: 15,
      lineHeight: 1.3,
      colorScheme: 'solarized-dark',
    });
    expect(mergePreferences({ terminal: { fontSize: 200, lineHeight: 5 } }).terminal).toMatchObject({
      fontSize: 72,
      lineHeight: 2,
    });
    expect(mergePreferences({ terminal: { colorScheme: 'Not An Id' } }).terminal.colorScheme).toBe('app');
    expect(mergePreferences({}).terminal.fontFamily).toBeUndefined();
  });

  it('reads terminal.localShell, empty (the OS default) when missing or not a string', () => {
    expect(mergePreferences({ terminal: { localShell: '/usr/local/bin/fish' } }).terminal.localShell).toBe(
      '/usr/local/bin/fish',
    );
    expect(mergePreferences({}).terminal.localShell).toBe('');
    expect(mergePreferences({ terminal: { localShell: 42 } }).terminal.localShell).toBe('');
  });

  it('reads and clamps terminal.reconnectAttempts', () => {
    const read = (value: number) =>
      mergePreferences({ terminal: { reconnectAttempts: value } }).terminal.reconnectAttempts;
    expect(read(25)).toBe(25);
    expect(read(0)).toBe(1);
    expect(read(500)).toBe(100);
    expect(read(2.4)).toBe(2);
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
  it('starts with no proxy, no extra anchors, a TLS 1.2 floor and HTTP/2 offered', () => {
    expect(DEFAULT_PREFERENCES.proxy).toEqual({ mode: 'none', excludes: [] });
    expect(DEFAULT_PREFERENCES.ssl).toEqual({ minVersion: 'TLSv1.2', expiryWarningDays: 30, trustAll: false });
    expect(DEFAULT_PREFERENCES.http.offerH2).toBe(true);
  });

  it('drops the old allowH2 key, which every saved file carries as false (ADR-0024)', () => {
    const merged = mergePreferences({ http: { allowH2: false, maxConnections: 7 } });
    expect(merged.http.offerH2).toBe(true);
    expect(merged.http.maxConnections).toBe(7);
    expect(merged.http).not.toHaveProperty('allowH2');
  });

  it('keeps HTTP/2 off once the user turns it off', () => {
    expect(mergePreferences({ http: { offerH2: false } }).http.offerH2).toBe(false);
  });

  it('keeps a certificate expiry warning window in range, clamping one read from disk', () => {
    expect(mergePreferences({ ssl: { expiryWarningDays: 7 } }).ssl.expiryWarningDays).toBe(7);
    expect(mergePreferences({ ssl: { expiryWarningDays: 0 } }).ssl.expiryWarningDays).toBe(0);
    expect(mergePreferences({ ssl: { expiryWarningDays: -1 } }).ssl.expiryWarningDays).toBe(0);
    expect(mergePreferences({ ssl: { expiryWarningDays: 2.5 } }).ssl.expiryWarningDays).toBe(3);
    expect(mergePreferences({ ssl: { expiryWarningDays: 99_999 } }).ssl.expiryWarningDays).toBe(3650);
    expect(mergePreferences({ ssl: { expiryWarningDays: 'soon' } }).ssl.expiryWarningDays).toBe(30);
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

describe('git preferences', () => {
  it('defaults to no configured path', () => {
    expect(DEFAULT_PREFERENCES.git).toEqual({});
  });

  it('merges the configured path and its picked-by-main marker like the section resets', () => {
    const merged = mergePreferences({ git: { path: '/usr/local/bin/git', pathPickedByMain: true } });
    expect(merged.git.path).toBe('/usr/local/bin/git');
    expect(merged.git.pathPickedByMain).toBe(true);
  });

  it('resets the git section, leaving the others alone', () => {
    const current = mergePreferences({ git: { path: '/usr/bin/git', pathPickedByMain: true } });
    const reset = resetPreferences(current, 'git');
    expect(reset.git).toEqual(DEFAULT_PREFERENCES.git);
  });
});

describe('ui.logSize', () => {
  it('defaults to 500 and is clamped to 100–5000', () => {
    expect(DEFAULT_PREFERENCES.ui.logSize).toBe(500);
    expect(mergePreferences({ ui: { logSize: 20 } }).ui.logSize).toBe(100);
    expect(mergePreferences({ ui: { logSize: 99999 } }).ui.logSize).toBe(5000);
    expect(mergePreferences({ ui: {} }).ui.logSize).toBe(500);
  });
});

describe('numeric preference limits', () => {
  it('every default sits inside its own limit', () => {
    for (const [key, limit] of Object.entries(PREFERENCE_NUMBER_LIMITS)) {
      const [section, field] = key.split('.') as [keyof typeof DEFAULT_PREFERENCES, string];
      const value = (DEFAULT_PREFERENCES[section] as unknown as Record<string, number | undefined>)[field];
      if (value === undefined) {
        continue; // an optional field with no default (proxy.port, rest.oauth2CallbackPort)
      }
      expect(value, key).toBeGreaterThanOrEqual(limit.min);
      if ('max' in limit) {
        expect(value, key).toBeLessThanOrEqual(limit.max);
      }
    }
  });

  it('describes a rule in words', () => {
    expect(describePreferenceLimit({ min: 1, max: 65_535, integer: true })).toBe('a whole number from 1 to 65535');
    expect(describePreferenceLimit({ min: 0, integer: true })).toBe('a whole number of 0 or more');
    expect(describePreferenceLimit({ min: 0.5, max: 2, integer: false })).toBe('a number from 0.5 to 2');
  });

  it.each([
    [{ proxy: { port: 80.5 } }, 'proxy.port must be a whole number from 1 to 65535'],
    [{ proxy: { port: 99_999 } }, 'proxy.port must be a whole number from 1 to 65535'],
    [{ proxy: { port: 0 } }, 'proxy.port must be a whole number from 1 to 65535'],
    [{ rest: { oauth2CallbackPort: 80 } }, 'rest.oauth2CallbackPort must be a whole number from 1024 to 65535'],
    [{ rest: { prettyPrintMaxBytes: 0 } }, 'rest.prettyPrintMaxBytes must be a whole number from 1 to 1073741824'],
    [{ rest: { maxRedirects: 51 } }, 'rest.maxRedirects must be a whole number from 0 to 50'],
    [{ editor: { fontSize: 100 } }, 'editor.fontSize must be a whole number from 6 to 72'],
    [{ editor: { tabSize: 0 } }, 'editor.tabSize must be a whole number from 1 to 16'],
    [{ ui: { historyCap: 1.5 } }, 'ui.historyCap must be a whole number from 1 to 100000'],
    [{ ui: { logSize: 6000 } }, 'ui.logSize must be a whole number from 100 to 5000'],
    [{ http: { socketTimeoutMs: -1 } }, 'http.socketTimeoutMs must be a whole number from 0 to 3600000'],
    [{ http: { maxConnections: 0 } }, 'http.maxConnections must be a whole number from 1 to 1000'],
    [
      { http: { chunkingThreshold: Number.POSITIVE_INFINITY } },
      'http.chunkingThreshold must be a whole number of 0 or more',
    ],
    [{ secrets: { sourceCacheSeconds: 3601 } }, 'secrets.sourceCacheSeconds must be a whole number from 0 to 3600'],
    [{ ssl: { expiryWarningDays: 3651 } }, 'ssl.expiryWarningDays must be a whole number from 0 to 3650'],
    [{ terminal: { reconnectAttempts: 0 } }, 'terminal.reconnectAttempts must be a whole number from 1 to 100'],
    [{ terminal: { reconnectAttempts: 101 } }, 'terminal.reconnectAttempts must be a whole number from 1 to 100'],
    [{ terminal: { fontSize: 5 } }, 'terminal.fontSize must be a whole number from 6 to 72'],
    [{ terminal: { lineHeight: 2.5 } }, 'terminal.lineHeight must be a number from 1 to 2'],
  ])('refuses %j in a patch, naming the rule', (patch, message) => {
    expect(preferencesPatchProblems(patch)).toEqual([message]);
  });

  it('accepts in-range values, null for a clearable port, and ignores unknown sections', () => {
    expect(
      preferencesPatchProblems({
        proxy: { port: 8080 },
        rest: { oauth2CallbackPort: null, prettyPrintMaxBytes: 10_486 },
        editor: { fontSize: 72, tabSize: 16 },
        ui: { historyCap: 100_000, logSize: 100 },
        nonsense: { anything: 1 },
      }),
    ).toEqual([]);
    expect(preferencesPatchProblems(undefined)).toEqual([]);
  });

  it('reports a value of the wrong type with its path', () => {
    expect(preferencesPatchProblems({ wsdl: { sampleValues: 'yes' } })).toEqual([
      expect.stringMatching(/^wsdl\.sampleValues: /) as unknown as string,
    ]);
  });

  it('clears an optional port when a patch sets it to null', () => {
    const base = mergePreferences({
      proxy: { mode: 'manual', host: 'proxy', port: 3128 },
      rest: { oauth2CallbackPort: 8765 },
    });
    const cleared = mergePreferences({ proxy: { port: null }, rest: { oauth2CallbackPort: null } }, base);
    expect(cleared.proxy).not.toHaveProperty('port');
    expect(cleared.proxy.host).toBe('proxy');
    expect(cleared.rest).not.toHaveProperty('oauth2CallbackPort');
    // `undefined` still means "leave it alone".
    expect(mergePreferences({ proxy: { port: undefined } }, base).proxy.port).toBe(3128);
  });
});

describe('loading a file written before the limits were tightened', () => {
  /** What an older build could have written: every value now out of range, siblings valid. */
  const OLD_FILE = {
    version: 1,
    http: { userAgent: 'Old/1', socketTimeoutMs: 10_000_000, maxConnections: 5000, chunkingThreshold: -4 },
    proxy: { mode: 'manual', host: 'proxy.internal', port: 99_999, excludes: ['localhost'] },
    rest: { defaultAccept: 'application/json', oauth2CallbackPort: 80, prettyPrintMaxBytes: 0, maxRedirects: 500 },
    editor: { fontFamily: 'Fira Code', fontSize: 200, tabSize: 2.4, wordWrap: true },
    ui: { theme: 'light', historyCap: 0, logSize: 20 },
  };

  it('clamps each out-of-range value and keeps every sibling field', () => {
    const merged = mergePreferences(OLD_FILE);
    expect(merged.http).toMatchObject({
      userAgent: 'Old/1',
      socketTimeoutMs: 3_600_000,
      maxConnections: 1000,
      chunkingThreshold: 0,
    });
    expect(merged.proxy).toMatchObject({
      mode: 'manual',
      host: 'proxy.internal',
      port: 65_535,
      excludes: ['localhost'],
    });
    expect(merged.rest).toMatchObject({
      defaultAccept: 'application/json',
      oauth2CallbackPort: 1024,
      prettyPrintMaxBytes: 1,
      maxRedirects: 50,
    });
    expect(merged.editor).toMatchObject({ fontFamily: 'Fira Code', fontSize: 72, tabSize: 2, wordWrap: true });
    expect(merged.ui).toMatchObject({ theme: 'light', historyCap: 1, logSize: 100 });
  });

  it('produces a document the strict schema accepts', () => {
    const merged = mergePreferences(OLD_FILE);
    expect(preferencesPatchProblems(merged)).toEqual([]);
    expect(preferencesSchema.safeParse({ version: 1, ...merged }).success).toBe(true);
  });

  it('still loses only the section holding a value of the wrong type', () => {
    const merged = mergePreferences({ ...OLD_FILE, editor: { fontSize: 'big', tabSize: 2 } });
    expect(merged.editor).toEqual(DEFAULT_PREFERENCES.editor);
    expect(merged.proxy.port).toBe(65_535);
  });
});

describe('withAppUserAgent', () => {
  const withUserAgent = (userAgent: string) => mergePreferences({ http: { userAgent } });

  it('moves a default User-Agent, of this release or an earlier one, to the running version', () => {
    for (const stale of ['Wirebench', 'Wirebench/0.1', 'Wirebench/6.0.0', 'Wirebench/6.1.0-rc.3']) {
      expect(withAppUserAgent(withUserAgent(stale), '6.1.0').http.userAgent).toBe('Wirebench/6.1.0');
    }
  });

  it('keeps a User-Agent the user wrote, and an empty one that sends none', () => {
    for (const own of ['Wirebench/6.1.0 (ci)', 'Mozilla/5.0', 'wirebench-bot', '']) {
      expect(withAppUserAgent(withUserAgent(own), '6.1.0').http.userAgent).toBe(own);
    }
  });

  it('returns the same document when nothing changes, and leaves every other setting alone', () => {
    const current = withUserAgent('Wirebench/6.1.0');
    expect(withAppUserAgent(current, '6.1.0')).toBe(current);
    const moved = withAppUserAgent(withUserAgent('Wirebench/0.1'), '6.1.0');
    expect(moved.http.socketTimeoutMs).toBe(DEFAULT_PREFERENCES.http.socketTimeoutMs);
    expect(moved.editor).toEqual(DEFAULT_PREFERENCES.editor);
  });
});
