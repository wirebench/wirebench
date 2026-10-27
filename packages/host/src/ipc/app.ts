import type { Caller, HostPlatform } from '../host/platform.js';
import { AREAS } from '@wirebench/wire/area-module';
import type { AreaId } from '@wirebench/wire/area-module';
import type { KindId } from '@wirebench/wire/kinds/kind-module';
import { channels } from '@wirebench/wire/ipc';
import type { AppFeaturesWire, FeatureStateWire, MenuCommandWire, UpdateStatusWire } from '@wirebench/wire/wire-base';
import { registerHandler, type HandlerTable } from './register.js';
import { KINDS } from '@wirebench/wire/kinds/kind-module';

/**
 * Installs the application menu from the renderer's command manifest and wires its clicks back to
 * a window; answers how many command items the menu carries. The desktop's is
 * `apps/desktop/src/main/electron/app-menu.ts`.
 */
export type AppMenu = (items: readonly MenuCommandWire[], sender: Caller) => number;

/** What `registerAppChannels` needs of the host: the app's version facts, and a menu where there is one. */
export interface AppHost {
  readonly app: Pick<HostPlatform['app'], 'packaged' | 'version' | 'runtimeVersion'>;
  /** Absent on a host with no native menu; `app.registerMenu` then answers no items. */
  readonly menu?: AppMenu;
}

/**
 * Registers the `app.*` IPC channels: the version triple, the application menu the renderer
 * generates from its command registry, and the user-run update check.
 *
 * `host.menu` is injectable so the menu can be asserted on with a fake. `checkForUpdates` is injectable for the same reason, and is absent in a
 * development run — the channel still answers, with the same "could not check" the offline
 * case gets, so the renderer needs no second code path. `newWindow` opens another window; absent (a
 * test), the channel answers without one.
 */
export function registerAppChannels(
  table: HandlerTable,
  host: AppHost,
  checkForUpdates: () => Promise<UpdateStatusWire> = () =>
    Promise.resolve({ kind: 'error', message: 'Could not check for updates' }),
  newWindow: () => void = () => undefined,
  enabledAreas: readonly AreaId[] = AREAS.map((area) => area.id),
  /** The calling window's workspace's kinds and feature rows (phase 4 spec §6.2); a test's default has everything on. */
  features: { kinds: () => readonly KindId[]; features?: () => readonly string[]; states: () => AppFeaturesWire } = {
    kinds: () => KINDS.map((kind) => kind.kind),
    states: () => ({ states: [] }),
  },
  localTerminal = enabledAreas.includes('ssh'),
  telnet = enabledAreas.includes('ssh'),
  serial = enabledAreas.includes('ssh'),
  /** The area rows Settings → Features → Areas shows (#360); a test's default has none. */
  areaStates: () => readonly FeatureStateWire[] = () => [],
): void {
  registerHandler(table, channels.app.version, () =>
    Promise.resolve({
      version: host.app.version(),
      electron: host.app.runtimeVersion(),
      node: process.versions.node,
    }),
  );

  registerHandler(table, channels.app.areas, () =>
    Promise.resolve({ enabled: [...enabledAreas], localTerminal, telnet, serial }),
  );

  registerHandler(table, channels.app.kinds, () =>
    Promise.resolve({
      enabled: [...features.kinds()],
      ...(features.features !== undefined ? { features: [...features.features()] } : {}),
    }),
  );

  registerHandler(table, channels.app.features, () =>
    Promise.resolve({ ...features.states(), areas: [...areaStates()] }),
  );

  registerHandler(table, channels.app.checkForUpdates, async () => ({ status: await checkForUpdates() }));

  registerHandler(table, channels.app.newWindow, () => {
    newWindow();
    return Promise.resolve({});
  });

  registerHandler(table, channels.app.registerMenu, (request, sender) =>
    Promise.resolve({ items: host.menu?.(request.items, sender) ?? 0 }),
  );
}
