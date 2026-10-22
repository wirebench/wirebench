/**
 * GraphQL's share of the IPC registry (phase 6 spec §3.4): the GraphQL editor's `request.*` channels
 * and the API schema's `api.*` channels, with the names they always had. `ipc.ts` spreads them beside
 * REST's, whose body kind GraphQL is.
 */
import { z } from 'zod';
import { defineChannel } from '../../ipc-contract.js';
import { requestGraphqlIntrospectRequestSchema } from '../rest/wire.js';
import {
  apiGraphqlSchemaRequestSchema,
  apiImportGraphqlSchemaRequestSchema,
  graphqlSchemaRefWireSchema,
  requestGraphqlCompleteRequestSchema,
  requestGraphqlCompleteResponseSchema,
  requestGraphqlDiagnosticsRequestSchema,
  requestGraphqlDiagnosticsResponseSchema,
  requestGraphqlHoverRequestSchema,
  requestGraphqlHoverResponseSchema,
} from './wire.js';

export const graphqlChannels = {
  request: {
    /**
     * Sends the standard introspection query through a GraphQL request as edited — its URL, headers,
     * auth and environment, but not its scripts — and stores the answer as its API's schema (#77).
     * Leaves no History entry and no HTTP Log row.
     */
    graphqlIntrospect: defineChannel(
      'request.graphqlIntrospect',
      requestGraphqlIntrospectRequestSchema,
      graphqlSchemaRefWireSchema,
    ),
    /** The GraphQL editor's markers for its query and variables, from the API's schema. */
    graphqlDiagnostics: defineChannel(
      'request.graphqlDiagnostics',
      requestGraphqlDiagnosticsRequestSchema,
      requestGraphqlDiagnosticsResponseSchema,
    ),
    /** Completion at the caret of the GraphQL editor's query or variables. */
    graphqlComplete: defineChannel(
      'request.graphqlComplete',
      requestGraphqlCompleteRequestSchema,
      requestGraphqlCompleteResponseSchema,
    ),
    /** Hover documentation in the GraphQL editor's query. */
    graphqlHover: defineChannel(
      'request.graphqlHover',
      requestGraphqlHoverRequestSchema,
      requestGraphqlHoverResponseSchema,
    ),
  },
  api: {
    /** Reads a GraphQL schema file the person picks (SDL or an introspection result) into the API (#77). */
    importGraphqlSchema: defineChannel(
      'api.importGraphqlSchema',
      apiImportGraphqlSchemaRequestSchema,
      graphqlSchemaRefWireSchema,
    ),
    /** Removes the API's GraphQL schema. */
    clearGraphqlSchema: defineChannel('api.clearGraphqlSchema', apiGraphqlSchemaRequestSchema, z.object({})),
  },
} as const;
