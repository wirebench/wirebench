/**
 * Wire-shaped sync types. Task 9 moved the definitions themselves into
 * `apps/desktop/src/shared/wire-types.ts` as zod schemas (`syncStatusWireSchema`, …); this module
 * now just re-exports the inferred types under their original names so no main-process import
 * needed to change.
 */

export type {
  SyncState,
  SyncStatusWire,
  SyncConflictWire,
  SyncLogEntryWire,
  SyncPulledEvent,
} from '../../shared/wire-types.js';
