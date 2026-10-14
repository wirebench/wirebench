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
// Whether pasted text is a curl command, so the import dialog refuses what main would refuse.
export { notCurlReason } from '../http/curl-start.js';
// The `${secret:name}` name rule, so the renderer's secret review checks a name typed into it
// exactly as main's move will — a request's headers, query and body are where those tokens land.
export { SECRET_NAME_PATTERN } from '../secrets/secret-token.js';
// Where a text's `${…}` references are, so the editor completes, explains and marks them (#340)
// by the same scanning rules the send expands them with.
export { propertyReferences, type PropertyReference, type PropertyReferenceForm } from '../project/references.js';
// The Dynamic scope's generators, which the body editors' `${$` completion lists (#333).
export { DYNAMIC_GENERATORS, type DynamicGeneratorInfo } from '../project/dynamic.js';
export {
  createSseParser,
  eventStreamDocument,
  isEventStream,
  serializeEventStream,
  type SseParser,
  type SseRow,
} from '../http/sse.js';
export {
  applyJsonFormEdit,
  buildJsonForm,
  toWireSchema,
  type JsonFormEdit,
  type JsonFormKind,
  type JsonFormNode,
  type JsonFormOptions,
  type JsonFormValueType,
} from './json-form.js';
export type { JsonSchema, JsonValue } from './openapi/model.js';
