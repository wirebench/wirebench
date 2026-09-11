import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { menuManifest } from '../../src/renderer/shell/app-menu.js';
import { setKeybindingOverrides, toAccelerator } from '../../src/renderer/lib/keybindings.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

describe('toAccelerator', () => {
  it('renders a Mod chord in Electron notation', () => {
    expect(toAccelerator('Mod+Shift+F')).toBe('CmdOrCtrl+Shift+F');
  });

  it('names the special keys the Electron way', () => {
    expect(toAccelerator('Mod+Enter')).toBe('CmdOrCtrl+Return');
    expect(toAccelerator('Alt+Right')).toBe('Alt+Right');
    expect(toAccelerator('Mod+Backslash')).toBe('CmdOrCtrl+\\');
  });

  it('refuses a chord that would steal a bare key from the app', () => {
    expect(toAccelerator('Escape')).toBeUndefined();
    expect(toAccelerator('Shift+Tab')).toBeUndefined();
  });
});

describe('menuManifest', () => {
  beforeEach(() => {
    installWirebenchApi();
    setKeybindingOverrides({});
    registerShellCommands(() => undefined);
  });

  it('lists every registered command with a label and a category', () => {
    const manifest = menuManifest();

    expect(manifest.length).toBeGreaterThan(60);
    for (const item of manifest) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.category.length).toBeGreaterThan(0);
    }
  });

  it('carries the accelerator for a command that has one', () => {
    expect(menuManifest().find((item) => item.id === 'request.send')?.accelerator).toBe('CmdOrCtrl+Return');
  });

  it('leaves a bare-key command without an accelerator', () => {
    const cancel = menuManifest().find((item) => item.id === 'request.cancel');

    expect(cancel).toBeDefined();
    expect(cancel?.accelerator).toBeUndefined();
  });

  it('reflects a rebinding', () => {
    setKeybindingOverrides({ 'request.send': 'Mod+Shift+Enter' });

    expect(menuManifest().find((item) => item.id === 'request.send')?.accelerator).toBe('CmdOrCtrl+Shift+Return');
  });

  it('drops the accelerator for a command the user unbound', () => {
    setKeybindingOverrides({ 'request.send': '' });

    expect(menuManifest().find((item) => item.id === 'request.send')?.accelerator).toBeUndefined();
  });
});
