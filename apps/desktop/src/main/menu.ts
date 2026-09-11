/**
 * The native application menu, generated from the renderer's command registry.
 *
 * Main owns no command vocabulary of its own: the renderer sends a manifest through
 * `app.registerMenu` (id, label, category, accelerator), this module turns it into an Electron
 * template, and clicking an item sends `command.invoke` back to the window that registered it.
 * Availability (`when`) is evaluated in the renderer, so every generated item stays enabled and
 * the registry decides — one gate, not two that can disagree.
 *
 * Electron's own roles (undo/redo/cut/copy/paste, window, zoom, dev tools) stay native, because
 * they are wired to the focused control by the platform and have no command equivalent here.
 */

import type { MenuItemConstructorOptions } from 'electron';
import type { MenuCommandWire } from '../shared/wire-types.js';

/**
 * The one thing this module needs from Electron's `Menu`, as a single call so a test can pass a
 * fake that just records the template. Production wraps
 * `Menu.setApplicationMenu(Menu.buildFromTemplate(...))`.
 */
export interface MenuApi {
  install(template: MenuItemConstructorOptions[]): void;
}

/** Everything {@link buildCommandMenuTemplate} needs to know about the host. */
export interface MenuContext {
  /** macOS gets the app menu and a Window menu; the other platforms get neither. */
  readonly isMac: boolean;
  /** Adds Reload / Toggle Developer Tools to the View menu. */
  readonly isDev: boolean;
  /** Runs one command id — in practice, sends `command.invoke` to the focused window. */
  readonly dispatch: (id: string) => void;
}

/**
 * Which top-level menu each command category lands in, and in what order the menus appear.
 * A category missing from here is a bug in `shared/commands.ts`'s `CommandCategory` union, so
 * anything unrecognised falls into Tools rather than vanishing from the menu bar.
 */
const MENUS: readonly { readonly label: string; readonly categories: readonly string[] }[] = [
  { label: 'File', categories: ['Project', 'Definition'] },
  { label: 'Edit', categories: ['Editor'] },
  { label: 'View', categories: ['View'] },
  { label: 'Request', categories: ['Request'] },
  { label: 'Tools', categories: ['Explorer', 'Environment', 'Secrets', 'General'] },
];

const FALLBACK_MENU = 'Tools';

function itemsFor(commands: readonly MenuCommandWire[], categories: readonly string[], context: MenuContext) {
  return commands
    .filter((command) => categories.includes(command.category))
    .map<MenuItemConstructorOptions>((command) => ({
      id: command.id,
      label: command.label,
      ...(command.accelerator !== undefined ? { accelerator: command.accelerator } : {}),
      click: () => {
        context.dispatch(command.id);
      },
    }));
}

/** Every category the renderer sent that no menu claims, so nothing silently disappears. */
function unclaimedCategories(commands: readonly MenuCommandWire[]): readonly string[] {
  const claimed = new Set(MENUS.flatMap((menu) => menu.categories));
  return [...new Set(commands.map((command) => command.category))].filter((category) => !claimed.has(category));
}

/**
 * Builds the whole menu-bar template: the generated command menus interleaved with Electron's
 * native roles. Pure — it touches no Electron API, so it can be asserted on directly.
 */
export function buildCommandMenuTemplate(
  commands: readonly MenuCommandWire[],
  context: MenuContext,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (context.isMac) {
    template.push({ role: 'appMenu' });
  }

  for (const menu of MENUS) {
    const categories =
      menu.label === FALLBACK_MENU ? [...menu.categories, ...unclaimedCategories(commands)] : menu.categories;
    const items = itemsFor(commands, categories, context);

    if (menu.label === 'Edit') {
      // The clipboard roles come first: they are what "Edit" means to the OS, and they work on
      // whatever control has focus, including fields no command knows about.
      const roles: MenuItemConstructorOptions[] = [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ];
      template.push({
        label: 'Edit',
        submenu: [...roles, ...(items.length > 0 ? [{ type: 'separator' as const }] : []), ...items],
      });
      continue;
    }

    if (menu.label === 'View') {
      const roles: MenuItemConstructorOptions[] = [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(context.isDev
          ? [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }]
          : []),
      ];
      template.push({ label: 'View', submenu: [...items, { type: 'separator' }, ...roles] });
      continue;
    }

    if (items.length === 0) {
      continue;
    }
    template.push({ label: menu.label, submenu: items });
  }

  if (context.isMac) {
    template.push({ role: 'windowMenu' });
  }

  return template;
}

/**
 * Builds the menu from `commands` and installs it as the application menu.
 *
 * @returns how many command items the menu carries.
 */
export function applyCommandMenu(commands: readonly MenuCommandWire[], context: MenuContext, menuApi: MenuApi): number {
  menuApi.install(buildCommandMenuTemplate(commands, context));
  return commands.length;
}
