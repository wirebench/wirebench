import { z } from 'zod';
import { RUNNER_OVERRUNS } from './runner-defaults.js';
import { sequenceAssertionResultWireSchema } from './wire-base.js';

/**
 * Wire shapes of the Runner (#336): a folder, an API, a project or a sequence run many times, once per
 * row of a data file. A data file's path never crosses to the renderer (ADR-0005): main picks it,
 * keeps it with the target's settings, and the renderer sees its name, columns and row count only.
 * Every string of a result is masked before it leaves main. Renderer code imports these as types only;
 * its values live in `runner-defaults.ts`.
 */

/** What can be run: the entity's id, and what main found it to be. */
export const runnerTargetKindSchema = z.enum(['project', 'api', 'folder', 'request', 'sequence']);
export type RunnerTargetKind = z.infer<typeof runnerTargetKindSchema>;

/** The settings a target keeps between runs, in main's own storage (spec D4). */
export const runnerSettingsSchema = z.object({
  /** Absent: one per data row, or one without data. */
  iterations: z.number().int().min(1).max(10_000).optional(),
  delayMs: z.number().int().min(0).max(3_600_000),
  overrun: z.enum(RUNNER_OVERRUNS),
  bail: z.boolean(),
  /** Request ids in run order; ignored for a sequence, whose steps run in its own order. */
  order: z.array(z.string()),
  /** Request ids left out of the run. */
  excluded: z.array(z.string()),
});
export type RunnerSettings = z.infer<typeof runnerSettingsSchema>;

/** A data file as the renderer may see it. `error` when the file kept for the target no longer reads. */
export const runnerDataFileSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  rows: z.number().int(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type RunnerDataFile = z.infer<typeof runnerDataFileSchema>;

/** One request a target runs, in run order. */
export const runnerRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Where it sits: `Api/Folder/Request`, or `n. Step` for a sequence step. */
  path: z.string(),
  protocol: z.string(),
  /** A REST request's method, so the list can leave it out of a name that starts with it. */
  method: z.string().optional(),
});
export type RunnerRequest = z.infer<typeof runnerRequestSchema>;

export const runnerTargetRequestSchema = z.object({ targetId: z.string().min(1) });

/** `runner.state`: the target, its requests in run order, its settings and its data file. */
export const runnerStateSchema = z.object({
  targetId: z.string(),
  kind: runnerTargetKindSchema,
  name: z.string(),
  settings: runnerSettingsSchema,
  /** Every request the target holds, in run order (excluded ones included). */
  requests: z.array(runnerRequestSchema),
  data: runnerDataFileSchema.optional(),
});
export type RunnerState = z.infer<typeof runnerStateSchema>;

export const runnerSettingsSetSchema = z.object({ targetId: z.string().min(1), settings: runnerSettingsSchema });
export const runnerOkSchema = z.object({ ok: z.literal(true) });

export const runnerDataChooseResponseSchema = z.union([
  z.object({ cancelled: z.literal(true) }),
  z.object({ cancelled: z.literal(false), data: runnerDataFileSchema }),
]);
export type RunnerDataChooseResponse = z.infer<typeof runnerDataChooseResponseSchema>;

/** What happened to one request of one iteration. */
export const runnerRequestResultSchema = z.object({
  requestId: z.string().optional(),
  path: z.string(),
  name: z.string(),
  protocol: z.string(),
  outcome: z.enum(['passed', 'failed', 'errored', 'skipped']),
  status: z.number().optional(),
  durationMs: z.number().optional(),
  assertions: z.array(sequenceAssertionResultWireSchema),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  scriptLog: z.array(z.string()).optional(),
  iteration: z
    .object({ index: z.number().int(), count: z.number().int(), row: z.number().int().optional() })
    .optional(),
});
export type RunnerRequestResult = z.infer<typeof runnerRequestResultSchema>;

export const runnerSummarySchema = z.object({
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  errored: z.number().int(),
  skipped: z.number().int(),
  durationMs: z.number(),
  iterations: z.object({ planned: z.number().int(), run: z.number().int() }).optional(),
});
export type RunnerSummary = z.infer<typeof runnerSummarySchema>;

export const runnerRunResultSchema = z.object({
  runId: z.string(),
  targetId: z.string(),
  name: z.string(),
  startedAt: z.string(),
  environment: z.string().optional(),
  /** The data file's name, when the run read one. */
  dataFile: z.string().optional(),
  cancelled: z.boolean(),
  summary: runnerSummarySchema,
  requests: z.array(runnerRequestResultSchema),
});
export type RunnerRunResult = z.infer<typeof runnerRunResultSchema>;

/** `runner.run`: the renderer names the run, so it can stop it before the first request reports. */
export const runnerRunRequestSchema = z.object({ targetId: z.string().min(1), runId: z.string().min(1) });
export type RunnerRunRequest = z.infer<typeof runnerRunRequestSchema>;

export const runnerCancelRequestSchema = z.object({ runId: z.string() });
export const runnerCancelResponseSchema = z.object({ cancelled: z.boolean() });

/** A past run in the history list. */
export const runnerHistoryEntrySchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  environment: z.string().optional(),
  dataFile: z.string().optional(),
  cancelled: z.boolean(),
  summary: runnerSummarySchema,
});
export type RunnerHistoryEntry = z.infer<typeof runnerHistoryEntrySchema>;

export const runnerHistoryListResponseSchema = z.object({ runs: z.array(runnerHistoryEntrySchema) });
export const runnerHistoryGetRequestSchema = z.object({ targetId: z.string().min(1), runId: z.string().min(1) });
export const runnerHistoryGetResponseSchema = z.object({ run: runnerRunResultSchema.optional() });

/** One request of a running run has ended; `runner.run` resolves with all of them at the end. */
export const runnerProgressEventSchema = z.object({
  runId: z.string(),
  targetId: z.string(),
  request: runnerRequestResultSchema,
});
export type RunnerProgressEvent = z.infer<typeof runnerProgressEventSchema>;
