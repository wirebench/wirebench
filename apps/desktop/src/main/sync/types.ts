/**
 * Wire-shaped sync types. Task 9 moved the definitions themselves into
 * `packages/wire/src/wire-base.ts` as zod schemas (`syncStatusWireSchema`, …); this module
 * now just re-exports the inferred types under their original names so no main-process import
 * needed to change.
 */

export type {
  SyncState,
  SyncStatusWire,
  SyncConflictWire,
  SyncLogEntryWire,
  SyncPulledEvent,
} from '@wirebench/wire/wire-base';
