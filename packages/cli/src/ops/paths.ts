/**
 * Where the desktop keeps History (spec §3): `<userData>/history/<projectId>.jsonl`. The desktop's
 * `userData` is Electron's `appData` plus the packaged product name, `Wirebench` (R3).
 */
import { join, posix, win32 } from 'node:path';
import { assertPathSegment } from '@wirebench/engine';

export function defaultUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Application Support', 'Wirebench');
  }
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    return win32.join(
      appData !== undefined && appData.length > 0 ? appData : win32.join(home, 'AppData', 'Roaming'),
      'Wirebench',
    );
  }
  const config = env['XDG_CONFIG_HOME'];
  return posix.join(config !== undefined && config.length > 0 ? config : posix.join(home, '.config'), 'Wirebench');
}

export function defaultHistoryDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  return (platform === 'win32' ? win32 : posix).join(defaultUserDataDir(platform, env, home), 'history');
}

/**
 * One project's History file. The id comes from the project's own `wirebench.yaml`, which may have
 * been written anywhere, so it must be one path segment — the desktop's `historyFilePath` rule.
 *
 * @throws WorkspaceError `workspace-path-invalid` for an id that is not one safe segment
 */
export function historyFileFor(historyDir: string, projectId: string): string {
  assertPathSegment(projectId);
  return join(historyDir, `${projectId}.jsonl`);
}
