/**
 * The Preferences → Git section: the git executable wirebench uses to sync a shared workspace.
 *
 * Modelled on `SslSection`'s CA bundle picker (`../network-section.js`) — the same
 * pick-or-contain rule applies. Main reads (and runs) whatever `git.path` names, so the
 * renderer never writes it itself: `preferences.update` refuses a patch carrying `git.path` or
 * `git.pathPickedByMain`, and the only ways the preference changes are `git.locate` (a native
 * file picker in main) and `git.clearPath`. This section only ever asks main to detect, locate
 * or clear — never `update`.
 */

import { useEffect, useState } from 'react';
import { Button } from '../../../components/button.js';
import { SettingsGroup, TextSetting } from '../../../components/settings-grid.js';
import { ipc } from '../../../state/ipc-client.js';
import type { GitLocationWire } from '../../../../shared/wire-types.js';
import type { SectionProps } from './section-props.js';

export function GitSection({ preferences }: SectionProps) {
  const git = preferences.git;
  const [detected, setDetected] = useState<GitLocationWire | null | undefined>(undefined);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function detect(): Promise<void> {
    const result = await ipc().git.detect({});
    if (result.ok) {
      setDetected(result.value.location);
    }
  }

  useEffect(() => {
    // Runs once on mount; `git-detect`/`git-locate`/`git-clear` each re-detect explicitly.
    void detect();
  }, []);

  async function locate(): Promise<void> {
    setLocating(true);
    setError(undefined);
    try {
      // Main runs the native dialog, records the pick and persists it itself; the answer also
      // arrives as a `preferences.changed` broadcast. The renderer never names the path — see
      // `main/ipc/git.ts`.
      const result = await ipc().git.locate({});
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await detect();
    } finally {
      setLocating(false);
    }
  }

  async function clear(): Promise<void> {
    setError(undefined);
    const result = await ipc().git.clearPath({});
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await detect();
  }

  // Only a path main itself picked (`pathPickedByMain === true`, non-empty) is what `gitLocator`
  // actually uses — the same rule `configuredGitPath` applies in main. An unmarked value (e.g. a
  // hand-edited `preferences.yaml`) is inert to detection, so it must never be shown or offered
  // for Clear as though it were the git wirebench runs.
  const markedPath =
    git.pathPickedByMain === true && git.path !== undefined && git.path.length > 0 ? git.path : undefined;
  const pathValue = markedPath ?? detected?.path ?? '';

  return (
    <SettingsGroup title="Git">
      <TextSetting
        label="Git executable"
        value={pathValue}
        monospace
        readOnly
        testId="git-path"
        hint="Found automatically on PATH; choose one with Locate… if it is not."
        onCommit={() => undefined}
      />
      <div className="grid grid-cols-[minmax(8rem,14rem)_1fr] items-center gap-x-3 py-1">
        <span className="text-sm text-fg-muted">Version</span>
        <output data-testid="git-version" className="block truncate py-1 text-sm text-fg-muted">
          {detected === undefined
            ? 'Checking…'
            : detected === null
              ? 'Not found — install git to sync workspaces'
              : `git ${detected.version}`}
        </output>
      </div>
      <div className="grid grid-cols-[minmax(8rem,14rem)_1fr] items-center gap-x-3 py-1">
        <span />
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Button
              variant="secondary"
              data-testid="git-detect"
              onClick={() => {
                void detect();
              }}
            >
              Detect again
            </Button>
            <Button
              variant="secondary"
              disabled={locating}
              data-testid="git-locate"
              onClick={() => {
                void locate();
              }}
            >
              Locate…
            </Button>
            {markedPath !== undefined && (
              <Button
                variant="secondary"
                data-testid="git-clear"
                onClick={() => {
                  void clear();
                }}
              >
                Clear
              </Button>
            )}
          </div>
          {error !== undefined && (
            <p data-testid="git-error" role="alert" className="text-sm text-status-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </SettingsGroup>
  );
}
