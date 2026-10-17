import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/components/toast.js', () => ({ showToast: vi.fn() }));

import { showToast } from '../../src/renderer/components/toast.js';
import { isLockedByPolicy, usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

describe('preferences store', () => {
  beforeEach(() => {
    installWirebenchApi();
    vi.mocked(showToast).mockClear();
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: false });
  });

  it('loads the document from main', async () => {
    await usePreferencesStore.getState().load();
    expect(usePreferencesStore.getState().loaded).toBe(true);
    expect(usePreferencesStore.getState().preferences.http.userAgent).toBe('Wirebench');
  });

  /**
   * The shell renders from the `ui` store many times per frame and cannot await IPC, so every
   * incoming document is pushed into it. Without this, changing the theme in Preferences would
   * only take effect on the next launch.
   */
  it('pushes the theme, gutter and default layout into the ui store', async () => {
    useUiStore.getState().setTheme('dark');
    usePreferencesStore.getState().applyPreferences({
      ...DEFAULT_PREFERENCES_WIRE,
      editor: { ...DEFAULT_PREFERENCES_WIRE.editor, lineNumbers: false },
      ui: {
        ...DEFAULT_PREFERENCES_WIRE.ui,
        theme: 'light',
        defaultLayout: { orientation: 'stacked', mode: 'tabs' },
      },
    });

    expect(useUiStore.getState().theme).toBe('light');
    expect(useUiStore.getState().editorLineNumbers).toBe(false);
    expect(useUiStore.getState().editorLayout).toEqual({ orientation: 'stacked', mode: 'tabs' });
    await Promise.resolve();
  });

  it("applies an update optimistically, then takes main's reply", async () => {
    const update = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        preferences: { ...DEFAULT_PREFERENCES_WIRE, editor: { ...DEFAULT_PREFERENCES_WIRE.editor, tabSize: 7 } },
      },
    });
    installWirebenchApi({ preferences: { update } });

    const pending = usePreferencesStore.getState().update({ editor: { tabSize: 2 } });
    // Optimistic: the mirror already shows 2 before the round trip resolves.
    expect(usePreferencesStore.getState().preferences.editor.tabSize).toBe(2);
    await pending;
    // …and then whatever main actually persisted wins.
    expect(usePreferencesStore.getState().preferences.editor.tabSize).toBe(7);
  });

  it('puts back the last confirmed document and says why when main refuses an update', async () => {
    const confirmed = { ...DEFAULT_PREFERENCES_WIRE, proxy: { mode: 'manual' as const, port: 3128, excludes: [] } };
    usePreferencesStore.getState().applyPreferences(confirmed);
    type Refusal = { ok: false; error: { code: string; message: string } };
    let refuse: (value: Refusal) => void = () => undefined;
    installWirebenchApi({
      preferences: {
        update: vi.fn(
          () =>
            new Promise<Refusal>((resolve) => {
              refuse = resolve;
            }),
        ),
      },
    });

    const pending = usePreferencesStore.getState().update({ proxy: { port: 80 } });
    // Optimistic first…
    expect(usePreferencesStore.getState().preferences.proxy.port).toBe(80);
    refuse({
      ok: false,
      error: { code: 'preference-invalid', message: 'proxy.port must be a whole number from 1 to 65535' },
    });
    // …then rolled back, with the refusal surfaced.
    await expect(pending).resolves.toBe('proxy.port must be a whole number from 1 to 65535');
    expect(usePreferencesStore.getState().preferences.proxy.port).toBe(3128);
    expect(showToast).toHaveBeenCalledWith('Setting not saved: proxy.port must be a whole number from 1 to 65535');
  });

  it('answers undefined once main has saved an update', async () => {
    installWirebenchApi({
      preferences: {
        update: vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULT_PREFERENCES_WIRE } }),
      },
    });
    await expect(usePreferencesStore.getState().update({ editor: { tabSize: 3 } })).resolves.toBeUndefined();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('resets a section through main', async () => {
    const reset = vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULT_PREFERENCES_WIRE } });
    installWirebenchApi({ preferences: { reset } });
    await usePreferencesStore.getState().reset('editor');
    expect(reset).toHaveBeenCalledWith({ section: 'editor' });

    await usePreferencesStore.getState().reset();
    expect(reset).toHaveBeenLastCalledWith({});
  });
});

describe('preferences store policy', () => {
  it('fetches the managed-preferences policy from main', async () => {
    const policy = { path: '/etc/wirebench/policy.yaml', locked: ['proxy.mode'], ignored: [] };
    installWirebenchApi({ preferences: { policy: vi.fn().mockResolvedValue({ ok: true, value: policy }) } });
    usePreferencesStore.setState({ policy: undefined });
    await usePreferencesStore.getState().loadPolicy();
    expect(usePreferencesStore.getState().policy).toEqual(policy);
    expect(isLockedByPolicy(usePreferencesStore.getState().policy, 'proxy.mode')).toBe(true);
    expect(isLockedByPolicy(usePreferencesStore.getState().policy, 'proxy.port')).toBe(false);
    expect(isLockedByPolicy(undefined, 'proxy.mode')).toBe(false);
  });
});
