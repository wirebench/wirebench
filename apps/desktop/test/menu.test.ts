// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { applyCommandMenu, buildCommandMenuTemplate } from '../src/main/menu.js';
import type { MenuApi, MenuContext } from '../src/main/menu.js';
import type { MenuCommandWire } from '../src/shared/wire-types.js';

const COMMANDS: readonly MenuCommandWire[] = [
  { id: 'project.save', label: 'Save Project', category: 'Project', accelerator: 'CmdOrCtrl+S' },
  { id: 'definition.import', label: 'Import WSDL…', category: 'Definition', accelerator: 'CmdOrCtrl+I' },
  { id: 'editor.formatXml', label: 'Format Document', category: 'Editor', accelerator: 'CmdOrCtrl+Shift+F' },
  { id: 'view.toggleSidebar', label: 'Toggle Sidebar', category: 'View', accelerator: 'CmdOrCtrl+B' },
  { id: 'request.send', label: 'Send Request', category: 'Request', accelerator: 'CmdOrCtrl+Return' },
  { id: 'request.cancel', label: 'Cancel Request', category: 'Request' },
  { id: 'explorer.openRequest', label: 'Explorer: Open Request', category: 'Explorer' },
  { id: 'palette.open', label: 'Show All Commands', category: 'General', accelerator: 'CmdOrCtrl+K' },
];

function context(overrides: Partial<MenuContext> = {}): MenuContext {
  return { isMac: true, isDev: false, dispatch: vi.fn(), ...overrides };
}

function submenuOf(template: readonly MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const menu = template.find((item) => item.label === label);
  return (menu?.submenu ?? []) as MenuItemConstructorOptions[];
}

describe('buildCommandMenuTemplate', () => {
  it('puts the app and window roles around the generated menus on macOS', () => {
    const template = buildCommandMenuTemplate(COMMANDS, context());

    expect(template[0]?.role).toBe('appMenu');
    expect(template[template.length - 1]?.role).toBe('windowMenu');
  });

  it('omits the macOS-only roles elsewhere', () => {
    const template = buildCommandMenuTemplate(COMMANDS, context({ isMac: false }));

    expect(template.map((item) => item.role)).not.toContain('appMenu');
    expect(template.map((item) => item.role)).not.toContain('windowMenu');
  });

  it('groups commands into menus by category, carrying labels and accelerators', () => {
    const template = buildCommandMenuTemplate(COMMANDS, context());

    expect(submenuOf(template, 'File').map((item) => item.label)).toEqual(['Save Project', 'Import WSDL…']);
    expect(submenuOf(template, 'Request').map((item) => item.label)).toEqual(['Send Request', 'Cancel Request']);
    expect(submenuOf(template, 'Request')[0]?.accelerator).toBe('CmdOrCtrl+Return');
    expect(submenuOf(template, 'Request')[1]?.accelerator).toBeUndefined();
  });

  it('keeps the clipboard roles native at the top of Edit', () => {
    const edit = submenuOf(buildCommandMenuTemplate(COMMANDS, context()), 'Edit');

    expect(edit.slice(0, 2).map((item) => item.role)).toEqual(['undo', 'redo']);
    expect(edit.map((item) => item.label)).toContain('Format Document');
  });

  it('adds the developer roles to View only in a dev build', () => {
    const production = submenuOf(buildCommandMenuTemplate(COMMANDS, context()), 'View');
    const development = submenuOf(buildCommandMenuTemplate(COMMANDS, context({ isDev: true })), 'View');

    expect(production.map((item) => item.role)).not.toContain('toggleDevTools');
    expect(development.map((item) => item.role)).toContain('toggleDevTools');
    expect(development.map((item) => item.role)).toContain('reload');
  });

  it('collects the remaining categories under Tools', () => {
    const tools = submenuOf(buildCommandMenuTemplate(COMMANDS, context()), 'Tools');

    expect(tools.map((item) => item.label)).toEqual(['Explorer: Open Request', 'Show All Commands']);
  });

  it('files a category no menu claims under Tools rather than dropping it', () => {
    const extra: MenuCommandWire = { id: 'x.y', label: 'Novel Action', category: 'Novel' };
    const tools = submenuOf(buildCommandMenuTemplate([...COMMANDS, extra], context()), 'Tools');

    expect(tools.map((item) => item.label)).toContain('Novel Action');
  });

  it('dispatches the command id when an item is clicked', () => {
    const dispatch = vi.fn();
    const template = buildCommandMenuTemplate(COMMANDS, context({ dispatch }));
    const send = submenuOf(template, 'Request')[0];

    send?.click?.(undefined as never, undefined, undefined as never);

    expect(dispatch).toHaveBeenCalledWith('request.send');
  });

  it('leaves every generated item enabled — the renderer owns availability', () => {
    const template = buildCommandMenuTemplate(COMMANDS, context());

    for (const menu of template) {
      for (const item of (menu.submenu ?? []) as MenuItemConstructorOptions[]) {
        expect(item.enabled).toBeUndefined();
      }
    }
  });
});

describe('applyCommandMenu', () => {
  it('installs the built template and reports the item count', () => {
    const install = vi.fn();
    const menuApi: MenuApi = { install };

    expect(applyCommandMenu(COMMANDS, context(), menuApi)).toBe(COMMANDS.length);
    expect(install).toHaveBeenCalledTimes(1);
    expect((install.mock.calls[0]?.[0] as MenuItemConstructorOptions[])[0]?.role).toBe('appMenu');
  });
});
