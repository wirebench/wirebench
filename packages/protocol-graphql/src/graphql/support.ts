/**
 * What GraphQL hands REST (phase 6 spec §3.1). A GraphQL body is a REST body kind on disk; this is
 * what the body means: the JSON it is sent as, the API's schema, and the check its response gets.
 * The composition installs {@link graphqlSupport} into REST's slot. Nothing here imports REST
 * (ADR-0030), so the composition is where the compiler checks that the two shapes fit.
 */
import type { GraphQLSchema } from 'graphql';
import type { AssertionResult } from '#core/assert/model';
import type { FeatureDescriptor } from '#core/protocol/features';
import { lowerGraphqlBody, lowerGraphqlBodyText } from './body.js';
import type { GraphqlBody, LoweredGraphqlBody } from './body.js';
import { checkGraphqlResponse } from './check.js';
import type { GraphqlCheckResult } from './check.js';
import { cachedGraphqlSchema, readGraphqlSchema } from './schema.js';

/**
 * The switch for GraphQL. On by default: it shipped on in 6.1.0, and projects send it today.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export const GRAPHQL_FEATURE: FeatureDescriptor = {
  id: 'graphql',
  title: 'GraphQL',
  default: true,
  stage: 'experimental',
  requires: ['rest'],
};

/**
 * What REST calls for a GraphQL body.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface GraphqlSupport {
  /** The JSON body a send puts on the wire. @throws WirebenchError `graphql-variables-invalid` */
  lower(body: GraphqlBody): LoweredGraphqlBody;
  /** The same for an export of a saved request: the variables are kept as written. */
  lowerText(body: GraphqlBody): LoweredGraphqlBody;
  /** The API's schema, built once per SDL text; undefined when it has none or it does not build. */
  readSchema(projectDir: string, apiSlug: string): Promise<GraphQLSchema | undefined>;
  /**
   * The response checked against the operation as it went out, which a script may have changed:
   * `sentBody` is the JSON text that was sent, undefined when the body sent was not text.
   */
  checkSent(sentBody: string | undefined, responseText: string, schema: GraphQLSchema | undefined): GraphqlCheckResult;
  /** The run's check of a response: it fails when the response carries errors, whatever its status. */
  errorsCheck(result: GraphqlCheckResult): AssertionResult;
}

/** The query and operation name a sent JSON body carries, or `undefined` when it carries none. */
function sentOperation(
  text: string | undefined,
): { readonly query: string; readonly operationName?: string } | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const { query, operationName } = parsed as Record<string, unknown>;
    return typeof query !== 'string'
      ? undefined
      : { query, ...(typeof operationName === 'string' ? { operationName } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * GraphQL as REST's slot takes it.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export const graphqlSupport: GraphqlSupport = {
  lower: lowerGraphqlBody,
  lowerText: lowerGraphqlBodyText,
  async readSchema(projectDir, apiSlug) {
    const sdl = await readGraphqlSchema(projectDir, apiSlug);
    return sdl === undefined ? undefined : cachedGraphqlSchema(sdl);
  },
  checkSent(sentBody, responseText, schema) {
    const operation = sentOperation(sentBody);
    return checkGraphqlResponse({
      bodyText: responseText,
      query: operation?.query ?? '',
      ...(operation?.operationName !== undefined ? { operationName: operation.operationName } : {}),
      ...(schema !== undefined ? { schema } : {}),
    });
  },
  errorsCheck(result) {
    const count = result.errors.length;
    const shown = result.errors.slice(0, 3).map((error) => error.message);
    return {
      type: 'graphql',
      label: 'GraphQL errors',
      outcome: count === 0 ? 'passed' : 'failed',
      expected: 'none',
      actual:
        count === 0
          ? 'none'
          : `${String(count)} error${count === 1 ? '' : 's'}: ${shown.join('; ')}${count > shown.length ? '; …' : ''}`,
    };
  },
};
