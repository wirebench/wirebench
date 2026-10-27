import { machineEnv } from '../host/machine-env.js';
import type { HostPlatform } from '../host/platform.js';
import { requireCapability } from '../host/capability.js';
import { readFile, stat } from 'node:fs/promises';
import { channels } from '@wirebench/wire/ipc';
import { registerHandler, type HandlerTable } from './register.js';
import { nodeFs, writeFileAtomic } from '@wirebench/engine';

/** Refuse to load a file bigger than this into the editor. */
const MAX_LOAD_BYTES = 20 * 1024 * 1024;

/** e2e cannot drive native save/open dialogs, so these env vars short-circuit them to a fixed path. */
function e2eSavePathOverride(platform: Pick<HostPlatform, 'machineValues'>): string | undefined {
  return machineEnv(platform)['WIREBENCH_E2E_SAVE_PATH'];
}
function e2eOpenPathOverride(platform: Pick<HostPlatform, 'machineValues'>): string | undefined {
  return machineEnv(platform)['WIREBENCH_E2E_OPEN_PATH'];
}

/**
 * Registers the `fs.*` IPC channels: Save as… / Load from… for the request editor's raw XML
 * text. Distinct from `dialogs.*` (which only returns a chosen path) because these round-trip
 * file *content* through main, where Node's `fs` lives.
 */
export function registerFsChannels(
  table: HandlerTable,
  platform: Pick<HostPlatform, 'dialogs' | 'machineValues'>,
): void {
  registerHandler(table, channels.fs.saveText, async (request, sender) => {
    const override = e2eSavePathOverride(platform);
    let targetPath: string | undefined;
    if (override !== undefined) {
      targetPath = override;
    } else {
      const result = await requireCapability(platform, 'dialogs').saveFile(sender, {
        ...(request.defaultName !== undefined ? { defaultPath: request.defaultName } : {}),
      });
      targetPath = result.canceled ? undefined : result.filePath;
    }
    if (targetPath === undefined) {
      return { path: undefined };
    }
    // Atomic, like every other write the app makes (see `writeFileAtomic`): the bytes land in a
    // sibling temp file that is renamed over the target, so a crash mid-write cannot leave a
    // truncated file at the path the user chose.
    await writeFileAtomic(nodeFs, targetPath, request.text);
    return { path: targetPath };
  });

  registerHandler(table, channels.fs.openText, async (request, sender) => {
    const override = e2eOpenPathOverride(platform);
    let targetPath: string | undefined;
    if (override !== undefined) {
      targetPath = override;
    } else {
      const result = await requireCapability(platform, 'dialogs').openFile(sender, {
        properties: ['openFile'],
        ...(request.filters !== undefined ? { filters: request.filters } : {}),
      });
      targetPath = result.canceled ? undefined : result.filePaths[0];
    }
    if (targetPath === undefined) {
      return { path: undefined, text: undefined };
    }
    const info = await stat(targetPath);
    if (info.size > MAX_LOAD_BYTES) {
      throw new Error(`File is too large to load (${info.size} bytes, max ${MAX_LOAD_BYTES})`);
    }
    const text = await readFile(targetPath, 'utf-8');
    return { path: targetPath, text };
  });
}
