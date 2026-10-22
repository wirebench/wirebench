/**
 * The `json` report: its shape and rendering are the engine's (`packages/core/src/run/report.ts`), shared
 * with a server that stores run history (#343). The shape is the CLI's stable machine interface.
 */
export { renderJson, toJsonReport } from '@wirebench/engine';
export type { JsonReport, JsonReportRequest } from '@wirebench/engine';
