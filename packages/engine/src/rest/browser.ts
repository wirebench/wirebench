/**
 * Browser-safe subpath export (`@wirebench/engine/rest`): the URL helpers the REST editor needs in
 * the renderer, with no dependency on a Node module.
 *
 * The renderer has to split a URL into a path and a query table, put it back together, and find the
 * `{param}` placeholders in it — and it must do all three *exactly* as the send path does, or the
 * table and the URL would disagree about what is being sent. Re-exporting the engine's own
 * implementation is the only way to guarantee that; duplicating it in the renderer would mean two
 * sets of escaping rules to keep in step.
 */
export {
  composeUrl,
  encodeValue,
  joinBase,
  joinQuery,
  parseUrlParams,
  splitQuery,
  type ComposedUrl,
  type ComposeUrlOptions,
  type UrlProblem,
} from './url.js';
export type { KeyValueEntry } from './model.js';
// The `${secret:name}` name rule, so the renderer's secret review checks a name typed into it
// exactly as main's move will — a request's headers, query and body are where those tokens land.
export { SECRET_NAME_PATTERN } from '../secrets/secret-token.js';
export {
  createSseParser,
  eventStreamDocument,
  isEventStream,
  serializeEventStream,
  type SseParser,
  type SseRow,
} from './sse.js';
