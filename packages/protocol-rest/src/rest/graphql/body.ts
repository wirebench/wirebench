/**
 * A GraphQL body (#77) as the JSON a server reads: `{"query", "variables", "operationName"}`, the
 * GraphQL-over-HTTP convention. A send lowers the body right after expansion, so everything after
 * resolve — the script, the wire, History, cURL and code generation — sees an ordinary JSON body.
 */
import { WirebenchError } from '#core/errors';
import type { RestBody } from '../model.js';

/** A GraphQL body. */
export type GraphqlBody = Extract<RestBody, { kind: 'graphql' }>;

/** The raw JSON body a GraphQL body is sent as. */
export type LoweredGraphqlBody = Extract<RestBody, { kind: 'raw' }>;

/**
 * The JSON text a send puts on the wire. Blank variables are left out, and so is an absent operation
 * name; variables are parsed and written compactly, so what goes out is exactly one JSON document.
 *
 * @throws WirebenchError `graphql-variables-invalid` when the variables are not a JSON object
 */
export function graphqlPayload(body: GraphqlBody): string {
  const payload: Record<string, unknown> = { query: body.query };
  if (body.variables.trim() !== '') {
    let variables: unknown;
    try {
      variables = JSON.parse(body.variables) as unknown;
    } catch (error) {
      throw new WirebenchError('graphql-variables-invalid', 'The GraphQL variables are not valid JSON', {
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
    if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
      throw new WirebenchError('graphql-variables-invalid', 'The GraphQL variables must be a JSON object', {
        details: { reason: 'not an object' },
      });
    }
    payload['variables'] = variables;
  }
  if (body.operationName !== undefined && body.operationName !== '') payload['operationName'] = body.operationName;
  return JSON.stringify(payload);
}

/**
 * The same JSON written without parsing the variables, for a saved request that has not been
 * expanded: its variables may hold a reference in a value position (`{"id": ${id}}`), which is not
 * JSON until a send expands it. An export keeps that text as written, so the reference survives.
 */
export function graphqlPayloadText(body: GraphqlBody): string {
  const parts = [`"query":${JSON.stringify(body.query)}`];
  const variables = body.variables.trim();
  if (variables !== '') parts.push(`"variables":${variables}`);
  if (body.operationName !== undefined && body.operationName !== '') {
    parts.push(`"operationName":${JSON.stringify(body.operationName)}`);
  }
  return `{${parts.join(',')}}`;
}

/** A GraphQL body as the raw JSON body it is sent as (strict: the variables must parse). */
export function lowerGraphqlBody(body: GraphqlBody): LoweredGraphqlBody {
  return { kind: 'raw', language: 'json', text: graphqlPayload(body) };
}

/** A GraphQL body as raw JSON for an export of a saved request: the variables are kept as written. */
export function lowerGraphqlBodyText(body: GraphqlBody): LoweredGraphqlBody {
  return { kind: 'raw', language: 'json', text: graphqlPayloadText(body) };
}
