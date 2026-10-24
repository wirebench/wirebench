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
export { formatHtml } from './format-html.js';
// The API docs tab builds the same document main exports, so the tab and the file agree (Overview §3.3).
export {
  buildApiDocument,
  type ApiDocument,
  type DocBody,
  type DocExample,
  type DocFolder,
  type DocParam,
  type DocRequest,
  type DocsApiInput,
  type DocsFolderInput,
  type DocsRequestInput,
} from './docs/document.js';
// Whether a JSON body has comments, so Format and the JSON form refuse rather than drop them (#702).
export { hasJsonComments, stripJsonComments } from './json-comments.js';
// Which request calls a definition's operation, so a lint finding in Problems opens that request.
export { matchOperation, type RestOperationRef } from './openapi/match.js';
// What the send adds when the preferences ask for compressed responses, so Settings says exactly that.
export { REST_ACCEPT_ENCODING, SOAP_ACCEPT_ENCODING } from '#core/http/default-headers';
// Whether pasted text is a curl command, so the import dialog refuses what main would refuse.
export { notCurlReason } from '#core/http/curl-start';
// The `${secret:name}` name rule, so the renderer's secret review checks a name typed into it
// exactly as main's move will — a request's headers, query and body are where those tokens land.
export { SECRET_NAME_PATTERN } from '#core/secrets/secret-token';
// Where a text's `${…}` references are, so the editor completes, explains and marks them (#340)
// by the same scanning rules the send expands them with.
export { propertyReferences, type PropertyReference, type PropertyReferenceForm } from '#core/project/references';
// The Dynamic scope's generators, which the body editors' `${$` completion lists (#333).
export { DYNAMIC_GENERATORS, type DynamicGeneratorInfo } from '#core/project/dynamic';
export {
  createSseParser,
  eventStreamDocument,
  isEventStream,
  serializeEventStream,
  type SseParser,
  type SseRow,
} from '#core/http/sse';
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
