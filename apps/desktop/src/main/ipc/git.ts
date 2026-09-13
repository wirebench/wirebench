/**
 * The `git.*` IPC channels: discovery and the `git.path` preference, set and cleared by main
 * alone.
 *
 * `git.path` names an executable main *runs* on the tree it opens — a stricter reason than the
 * CA bundle's "reads on every send" — so it is held to the very same containment rule: the
 * renderer cannot write it (`preferences.update` refuses a patch carrying it, see
 * `MAIN_ONLY_KEYS` in `ipc/preferences.ts`), and instead asks main to detect it or run a picker.
 * Main records a picked path through `DialogPicks.rememberRead` (via the shared `pickFile`) and
 * persists it itself, alongside `pathPickedByMain: true`; `main/index.ts` re-records a pick at
 * startup only for a path carrying that marker, exactly as `rememberPickedCaBundle` does for the
 * CA bundle.
 */

import type { WebContents } from 'electron';
import { WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import { pickFile } from '../native-dialogs.js';
import type { RecordsReadPicks } from '../dialog-picks.js';
import { toPreferencesWire } from '../preferences.js';
import type { PreferencesService } from '../preferences.js';
import type { PreferencesWire } from '../../shared/wire-types.js';
import { findGit as defaultFindGit } from '../sync/git-cli.js';
import type { GitLocation } from '../sync/git-cli.js';
import { registerHandler } from './register.js';

/** What the `git.*` channels need; a stub stands in for each of these in tests. */
export interface GitChannelDeps {
  /** The preferences document; main writes `git.path` through it and nothing else does. */
  readonly preferences: Pick<PreferencesService, 'get' | 'update'>;
  /** The session's picked-path memory, the only evidence `GitCli` needs beyond the preference. */
  readonly picks: RecordsReadPicks;
  /** Injectable so tests never spawn a real process; defaults to the real `findGit`. */
  readonly findGit?: typeof defaultFindGit;
  /** Called after each change so main can broadcast `preferences.changed` to every window. */
  readonly onChanged?: (preferences: PreferencesWire) => void;
}

function toWire(location: GitLocation): GitLocation {
  return { path: location.path, version: location.version };
}

/** Registers the `git.*` channels. */
export function registerGitChannels(deps: GitChannelDeps): void {
  const findGit = deps.findGit ?? defaultFindGit;

  registerHandler(channels.git.detect, async () => {
    const configuredPath = deps.preferences.get().git.path;
    const location = await findGit(configuredPath !== undefined ? { configuredPath } : {});
    return { location: location === undefined ? null : toWire(location) };
  });

  registerHandler(channels.git.locate, async (_request, sender: WebContents) => {
    // A cancelled dialog changes nothing, including the git already configured — exactly as
    // `ssl.pickCaBundle` behaves for a cancelled CA bundle pick.
    const picked = await pickFile(sender, deps.picks, { title: 'Locate git' });
    if (picked === undefined) {
      return { preferences: toPreferencesWire(deps.preferences.get()) };
    }
    const location = await findGit({ configuredPath: picked });
    if (location === undefined) {
      throw new WirebenchError('git-not-found', `"${picked}" is not a usable git executable.`);
    }
    const next = toPreferencesWire(
      await deps.preferences.update({ git: { path: location.path, pathPickedByMain: true } }),
    );
    deps.onChanged?.(next);
    return { location: toWire(location), preferences: next };
  });

  registerHandler(channels.git.clearPath, async () => {
    // The marker goes with the path: what is cleared must not be re-recorded as a pick at the
    // next startup either.
    const next = toPreferencesWire(await deps.preferences.update({ git: { path: '', pathPickedByMain: false } }));
    deps.onChanged?.(next);
    return { preferences: next };
  });
}
