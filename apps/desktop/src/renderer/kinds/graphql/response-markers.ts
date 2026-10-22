/** A GraphQL response's markers on the response body (phase 6 spec §3.4). */
import type * as Monaco from 'monaco-editor';
import { contractRange, getMarkerApi, type MarkerApi } from '../../editor/markers.js';
import type { GraphqlCheckWire } from '../../../shared/kinds/graphql/wire.js';

/** Monaco's `MarkerSeverity.Error`/`.Warning`, inlined so this module needs no Monaco at import time. */
const ERROR = 8;
const WARNING = 4;

/** The `setModelMarkers` owner a GraphQL response's markers are filed under (#77). */
export const GRAPHQL_RESPONSE_MARKER_OWNER = 'wirebench-graphql-response';

/**
 * Converts a GraphQL check into markers against `text`: each entry of `errors` an error, each place
 * the `data` does not match the operation a warning.
 */
export function graphqlResponseMarkerData(
  check: GraphqlCheckWire | undefined,
  text: string,
): Monaco.editor.IMarkerData[] {
  if (check === undefined) {
    return [];
  }
  return [
    ...check.errors.map((error) => ({
      severity: ERROR,
      message: error.message,
      code: 'graphql-error',
      source: 'graphql',
      ...contractRange(text, error.pointer),
    })),
    ...check.problems.map((problem) => ({
      severity: WARNING,
      message: problem.message,
      code: 'graphql-schema',
      source: 'graphql',
      ...contractRange(text, problem.pointer),
    })),
  ];
}

/** Replaces the GraphQL markers on `model` with those of `check` located in `text`. */
export function setGraphqlResponseMarkers(
  model: Monaco.editor.ITextModel | null | undefined,
  check: GraphqlCheckWire | undefined,
  text: string,
  monaco: MarkerApi | undefined = getMarkerApi(),
): void {
  if (model === null || model === undefined || typeof monaco?.editor?.setModelMarkers !== 'function') {
    return;
  }
  monaco.editor.setModelMarkers(model, GRAPHQL_RESPONSE_MARKER_OWNER, graphqlResponseMarkerData(check, text));
}
