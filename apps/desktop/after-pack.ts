/**
 * electron-builder's `afterPack` entry for this package. The real hook is the shared
 * `scripts/fuses.ts`; this file only exists because electron-builder rejects a hook path that
 * resolves outside the directory it detects as the workspace root, and on Windows runners that
 * detection lands on `apps/desktop` rather than the repository.
 */
export { default } from '../../scripts/fuses.ts';
