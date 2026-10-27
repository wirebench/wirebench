import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_PREFERENCES } from '@wirebench/engine';
import { PREFERENCES_FILE, PreferencesService } from '../src/preferences.js';

describe('PreferencesService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-prefs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const file = (): string => join(dir, PREFERENCES_FILE);

  it('starts from the defaults when no file exists', async () => {
    const service = new PreferencesService(dir);
    expect(await service.ready()).toEqual(DEFAULT_PREFERENCES);
  });

  it('merges a partial file onto the defaults', async () => {
    writeFileSync(file(), 'version: 1\neditor:\n  tabSize: 2\n', 'utf8');
    const preferences = await new PreferencesService(dir).ready();
    expect(preferences.editor.tabSize).toBe(2);
    expect(preferences.editor.fontSize).toBe(DEFAULT_PREFERENCES.editor.fontSize);
  });

  it('falls back to the defaults for a corrupt file rather than failing to start', async () => {
    writeFileSync(file(), '{{{ not yaml', 'utf8');
    expect(await new PreferencesService(dir).ready()).toEqual(DEFAULT_PREFERENCES);
  });

  it('persists an update and reloads it', async () => {
    const service = new PreferencesService(dir);
    await service.update({ http: { userAgent: 'Custom/2' } });

    const written = parseYaml(readFileSync(file(), 'utf8')) as { version: number; http: { userAgent: string } };
    expect(written.version).toBe(1);
    expect(written.http.userAgent).toBe('Custom/2');
    expect((await new PreferencesService(dir).ready()).http.userAgent).toBe('Custom/2');
  });

  it('serialises overlapping updates instead of losing one', async () => {
    const service = new PreferencesService(dir);
    await Promise.all([
      service.update({ http: { userAgent: 'A/1' } }),
      service.update({ editor: { tabSize: 4 } }),
      service.update({ ui: { theme: 'light' } }),
    ]);
    const reloaded = await new PreferencesService(dir).ready();
    expect(reloaded.http.userAgent).toBe('A/1');
    expect(reloaded.editor.tabSize).toBe(4);
    expect(reloaded.ui.theme).toBe('light');
  });

  it('resets one section and leaves the others alone', async () => {
    const service = new PreferencesService(dir);
    await service.update({ editor: { tabSize: 8 }, http: { userAgent: 'Keep/1' } });
    const reset = await service.reset('editor');
    expect(reset.editor).toEqual(DEFAULT_PREFERENCES.editor);
    expect(reset.http.userAgent).toBe('Keep/1');
  });

  it('sends a default User-Agent as the running version, on load and after a reset', async () => {
    writeFileSync(file(), 'version: 1\nhttp:\n  userAgent: Wirebench/0.1\n', 'utf8');
    const service = new PreferencesService(dir, { appVersion: '6.1.0' });
    expect((await service.ready()).http.userAgent).toBe('Wirebench/6.1.0');

    await service.update({ http: { userAgent: 'Custom/1' } });
    expect(service.get().http.userAgent).toBe('Custom/1');
    // Settings' per-row reset sends the renderer's default, which names no version.
    await service.update({ http: { userAgent: 'Wirebench' } });
    expect(service.get().http.userAgent).toBe('Wirebench/6.1.0');
    const written = parseYaml(readFileSync(file(), 'utf8')) as { http: { userAgent: string } };
    expect(written.http.userAgent).toBe('Wirebench/6.1.0');

    expect((await service.reset('http')).http.userAgent).toBe('Wirebench/6.1.0');
    expect((await new PreferencesService(dir, { appVersion: '6.2.0' }).ready()).http.userAgent).toBe('Wirebench/6.2.0');
  });

  it('resets everything when no section is named', async () => {
    const service = new PreferencesService(dir);
    await service.update({ editor: { tabSize: 8 } });
    expect(await service.reset()).toEqual(DEFAULT_PREFERENCES);
  });

  it('notifies subscribers on every write, until they unsubscribe', async () => {
    const service = new PreferencesService(dir);
    const seen: string[] = [];
    const off = service.onChange((preferences) => seen.push(preferences.http.userAgent));
    await service.update({ http: { userAgent: 'One/1' } });
    off();
    await service.update({ http: { userAgent: 'Two/2' } });
    expect(seen).toEqual(['One/1']);
  });

  it('refuses an out-of-range update whole, naming the rule, and writes nothing', async () => {
    const service = new PreferencesService(dir);
    await service.update({ proxy: { mode: 'manual', host: 'proxy', port: 3128 } });
    const before = readFileSync(file(), 'utf8');

    await expect(service.update({ proxy: { port: 80.5 }, http: { userAgent: 'Never/1' } })).rejects.toMatchObject({
      code: 'preference-invalid',
      message: 'proxy.port must be a whole number from 1 to 65535',
    });
    expect(readFileSync(file(), 'utf8')).toBe(before);
    expect(service.get().proxy.port).toBe(3128);
    expect(service.get().http.userAgent).toBe(DEFAULT_PREFERENCES.http.userAgent);
    // …and the queue is not wedged by the refusal.
    await service.update({ proxy: { port: 8080 } });
    expect(service.get().proxy.port).toBe(8080);
  });

  it('clears an optional port when the update sets it to null', async () => {
    const service = new PreferencesService(dir);
    await service.update({ proxy: { mode: 'manual', port: 3128 }, rest: { oauth2CallbackPort: 8765 } });
    await service.update({ proxy: { port: null }, rest: { oauth2CallbackPort: null } });
    const reloaded = await new PreferencesService(dir).ready();
    expect(reloaded.proxy).not.toHaveProperty('port');
    expect(reloaded.rest).not.toHaveProperty('oauth2CallbackPort');
  });

  it('loads a file with values outside the current limits by clamping them, keeping the rest', async () => {
    writeFileSync(
      file(),
      [
        'version: 1',
        'proxy:',
        '  mode: manual',
        '  host: proxy.internal',
        '  port: 99999',
        'editor:',
        '  fontFamily: Fira Code',
        '  fontSize: 200',
        '  tabSize: 2',
        'rest:',
        '  oauth2CallbackPort: 80',
        '  defaultAccept: application/json',
        '',
      ].join('\n'),
      'utf8',
    );
    const preferences = await new PreferencesService(dir).ready();
    expect(preferences.proxy).toMatchObject({ mode: 'manual', host: 'proxy.internal', port: 65_535 });
    expect(preferences.editor).toMatchObject({ fontFamily: 'Fira Code', fontSize: 72, tabSize: 2 });
    expect(preferences.rest).toMatchObject({ oauth2CallbackPort: 1024, defaultAccept: 'application/json' });
  });

  it('exposes the current document synchronously once loaded', async () => {
    const service = new PreferencesService(dir);
    await service.update({ ui: { historyCap: 25 } });
    expect(service.get().ui.historyCap).toBe(25);
  });
});
