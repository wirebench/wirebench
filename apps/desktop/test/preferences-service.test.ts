import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_PREFERENCES } from '@wirebench/engine';
import { PREFERENCES_FILE, PreferencesService } from '../src/main/preferences.js';

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

  it('exposes the current document synchronously once loaded', async () => {
    const service = new PreferencesService(dir);
    await service.update({ ui: { historyCap: 25 } });
    expect(service.get().ui.historyCap).toBe(25);
  });
});
