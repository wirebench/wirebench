/**
 * The native folder/save pickers, factored out of `ipc/dialogs.ts` so main-side features that
 * write a file *themselves* (Export Definition, Generate Documentation) run the very same
 * dialog — and record the very same pick — instead of taking a path the renderer typed.
 *
 * The e2e overrides live here too, for the same reason: one place decides what a picker
 * answers, whether the caller is the `dialogs.*` channel or a feature handler.
 */

import { delimiter } from 'node:path';
import type { Caller, DialogFilter, HostPlatform } from './host/platform.js';
import { requireCapability } from './host/capability.js';
import type { RecordsReadPicks, RecordsWritePicks } from './dialog-picks.js';

export type { DialogFilter } from './host/platform.js';

/** The pickers a main-side feature runs; one set per platform, built by {@link createNativeDialogs}. */
export interface NativeDialogs {
  /** Runs the Open-file picker, recording the chosen path as a read pick. */
  pickFile: (
    sender: Caller,
    picks: RecordsReadPicks,
    options: { readonly title?: string; readonly filters?: readonly DialogFilter[] },
  ) => Promise<string | undefined>;
  /** Runs the folder picker, honouring the e2e override. */
  pickFolder: (
    sender: Caller,
    options?: { readonly title?: string },
    picks?: RecordsReadPicks,
  ) => Promise<string | undefined>;
  /** The write-side folder picker: records the chosen folder as a write pick. */
  pickFolderToWrite: (
    sender: Caller,
    picks: RecordsWritePicks,
    options?: { readonly title?: string },
  ) => Promise<string | undefined>;
  /** Runs the Save-as picker, recording the chosen path as a write pick and honouring the override. */
  pickSaveFile: (
    sender: Caller,
    picks: RecordsWritePicks,
    options?: {
      readonly title?: string;
      readonly filters?: readonly DialogFilter[];
      readonly defaultPath?: string;
    },
  ) => Promise<string | undefined>;
  /** Asks whether to send under the protected environments named (#345). */
  confirmProtected: (environmentNames: readonly string[]) => Promise<boolean>;
  /** The e2e Save-as answer, when one is set and honoured. */
  saveOverride: () => string | undefined;
}

/**
 * The pickers over `platform`'s native dialogs. The queue of e2e folder answers lives in the
 * returned object, so two platforms never share a position in it.
 */
export function createNativeDialogs(platform: Pick<HostPlatform, 'dialogs' | 'app'>): NativeDialogs {
  /**
   * Whether the e2e dialog overrides below may be honoured at all.
   *
   * They exist so Playwright can answer a native picker it cannot drive, and every e2e run is
   * unpackaged. In a shipped build they would let anything that can set an environment variable
   * decide which folder the app links, exports to or reads — without a dialog the user ever saw —
   * so a packaged app ignores them outright.
   */
  const e2eOverridesAllowed = (): boolean => !platform.app.packaged();
  const dialogs = () => requireCapability(platform, 'dialogs');

  /** How many entries of `WIREBENCH_E2E_DIALOG_FOLDERS` the folder pickers have consumed. */
  let queuedFolderAnswers = 0;

  /**
   * e2e cannot drive a native folder picker, so two variables short-circuit it. Both are read at
   * call time (not module load) so a spec can set them per launch.
   *
   * `WIREBENCH_E2E_DIALOG_FOLDERS` is a queue — paths separated by `path.delimiter`, one answer
   * per picker call, in order — for a spec that picks different folders in one launch (export a
   * project, then link it back). Once it is used up, or when it is unset, every call answers
   * with the single `WIREBENCH_E2E_DIALOG_FOLDER`.
   */
  const folderOverride = (): string | undefined => {
    if (!e2eOverridesAllowed()) {
      return undefined;
    }
    const queue = (process.env['WIREBENCH_E2E_DIALOG_FOLDERS'] ?? '').split(delimiter).filter((entry) => entry !== '');
    const next = queue[queuedFolderAnswers];
    if (next !== undefined) {
      queuedFolderAnswers += 1;
      return next;
    }
    return process.env['WIREBENCH_E2E_DIALOG_FOLDER'];
  };

  /** The save-dialog counterpart of {@link folderOverride}. */
  const saveOverride = (): string | undefined =>
    e2eOverridesAllowed() ? process.env['WIREBENCH_E2E_DIALOG_SAVE'] : undefined;

  /**
   * The open-file counterpart of {@link folderOverride}. A distinct variable from the keystore
   * picker's `WIREBENCH_E2E_OPEN_PATH` so a spec can pin the two independently — a spec that adds
   * a keystore *and* picks a CA bundle needs different answers from each.
   */
  const openFileOverride = (): string | undefined =>
    e2eOverridesAllowed() ? process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'] : undefined;

  return {
    saveOverride,

    async pickFile(sender, picks, options) {
      // The override goes through `rememberRead` exactly as a real pick does, so e2e exercises the
      // same containment path a user drives rather than a bypass of it.
      const override = openFileOverride();
      if (override !== undefined && override.length > 0) {
        picks.rememberRead(override);
        return override;
      }
      const result = await dialogs().openFile(sender, {
        properties: ['openFile'],
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.filters !== undefined ? { filters: options.filters } : {}),
      });
      const path = result.canceled ? undefined : result.filePaths[0];
      if (path !== undefined) {
        picks.rememberRead(path);
      }
      return path;
    },

    /**
     * `picks` is optional only because the original callers (Export Definition, Generate
     * Documentation) pick a folder they are about to write *inside the open project*, where
     * containment alone already answers for the path. A caller that picks a folder **outside** any
     * project — linking or importing a project folder — has no such evidence and must pass `picks`,
     * so the folder is recorded as a read pick exactly as `pickFile` records a file.
     */
    async pickFolder(sender, options = {}, picks) {
      // The override is recorded exactly as a real pick is, so e2e exercises the containment path
      // a user drives rather than a bypass of it.
      const override = folderOverride();
      if (override !== undefined) {
        picks?.rememberRead(override);
        return override;
      }
      const result = await dialogs().openFile(sender, {
        properties: ['openDirectory'],
        ...(options.title !== undefined ? { title: options.title } : {}),
      });
      const path = result.canceled ? undefined : result.filePaths[0];
      if (path !== undefined) {
        picks?.rememberRead(path);
      }
      return path;
    },

    /**
     * Exporting a project is a "write my project here" choice, and the read/write split in
     * {@link RecordsWritePicks} exists precisely so picking a folder to read from never silently
     * also grants it as a legal write target.
     */
    async pickFolderToWrite(sender, picks, options = {}) {
      const override = folderOverride();
      if (override !== undefined) {
        picks.rememberWrite(override);
        return override;
      }
      const result = await dialogs().openFile(sender, {
        properties: ['openDirectory', 'createDirectory'],
        ...(options.title !== undefined ? { title: options.title } : {}),
      });
      const path = result.canceled ? undefined : result.filePaths[0];
      if (path !== undefined) {
        picks.rememberWrite(path);
      }
      return path;
    },

    async pickSaveFile(sender, picks, options = {}) {
      const override = saveOverride();
      if (override !== undefined) {
        picks.rememberWrite(override);
        return override;
      }
      const result = await dialogs().saveFile(sender, {
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.filters !== undefined ? { filters: options.filters } : {}),
        ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
      });
      if (!result.canceled && result.filePath !== undefined) {
        picks.rememberWrite(result.filePath);
      }
      return result.canceled ? undefined : result.filePath;
    },

    /**
     * Over the focused window (no owner). Cancel is the default and the answer to Escape, so a
     * stray Enter never sends to production.
     */
    async confirmProtected(environmentNames) {
      const list = environmentNames.map((name) => `"${name}"`).join(', ');
      const one = environmentNames.length === 1;
      const { response } = await dialogs().message(undefined, {
        type: 'warning',
        buttons: ['Send', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: `Send to ${one ? (environmentNames[0] ?? '') : list}?`,
        detail: `${list} ${one ? 'is a protected environment' : 'are protected environments'}. Check this is where you mean to send.`,
      });
      return response === 0;
    },
  };
}
