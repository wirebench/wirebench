/**
 * GraphQL's wire schemas (phase 6 spec §3.4): the response check, the schema record and the editor's
 * assist channels. GraphQL is a REST body kind, so the body itself and the API's `graphqlSchema` field
 * stay in REST's wire; this file imports nothing of REST's, so REST's wire may import it.
 */
import { z } from 'zod';

/**
 * A GraphQL response checked (#77), the engine's `GraphqlCheckResult`: every entry of its `errors`
 * array, and where its `data` does not match the operation and the API's schema. `schema` says how
 * far the data check got.
 */
export const graphqlCheckWireSchema = z.object({
  schema: z.enum(['checked', 'no-schema', 'no-query', 'skipped', 'not-graphql']),
  errors: z.array(
    z.object({
      message: z.string(),
      path: z.array(z.union([z.string(), z.number()])).optional(),
      pointer: z.string(),
    }),
  ),
  problems: z.array(z.object({ pointer: z.string(), message: z.string() })),
});
export type GraphqlCheckWire = z.infer<typeof graphqlCheckWireSchema>;

/** Where an API's GraphQL schema came from (#77). */
export const graphqlSchemaRefWireSchema = z.object({ source: z.string(), fetchedAt: z.string() });
export type GraphqlSchemaRefWire = z.infer<typeof graphqlSchemaRefWireSchema>;

/** Request payload for `api.clearGraphqlSchema`. */
export const apiGraphqlSchemaRequestSchema = z.object({ apiId: z.string() });
export type ApiGraphqlSchemaRequest = z.infer<typeof apiGraphqlSchemaRequestSchema>;

/**
 * Request payload for `api.importGraphqlSchema`: a file picked with `dialogs.openFile` (or inside a
 * project folder), SDL or an introspection result.
 */
export const apiImportGraphqlSchemaRequestSchema = z.object({ apiId: z.string(), path: z.string() });
export type ApiImportGraphqlSchemaRequest = z.infer<typeof apiImportGraphqlSchemaRequestSchema>;

/** A range in the GraphQL editor, 1-based as Monaco counts. */
export const graphqlRangeWireSchema = z.object({
  startLine: z.number(),
  startColumn: z.number(),
  endLine: z.number(),
  endColumn: z.number(),
});
export type GraphqlRangeWire = z.infer<typeof graphqlRangeWireSchema>;

export const graphqlDiagnosticWireSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  range: graphqlRangeWireSchema,
});
export type GraphqlDiagnosticWire = z.infer<typeof graphqlDiagnosticWireSchema>;

/**
 * What the GraphQL editor asks about: the query and variables as typed, unsaved, and the API whose
 * schema answers. Without an API (a webhook item) only the syntax is checked.
 */
const graphqlAssistBaseSchema = z.object({
  apiId: z.string().optional(),
  query: z.string(),
  variables: z.string().optional(),
  operationName: z.string().optional(),
});

/** Request payload for `request.graphqlDiagnostics`. */
export const requestGraphqlDiagnosticsRequestSchema = graphqlAssistBaseSchema;
export type RequestGraphqlDiagnosticsRequest = z.infer<typeof requestGraphqlDiagnosticsRequestSchema>;

/** Response for `request.graphqlDiagnostics`: each editor's markers, and the document's named operations. */
export const requestGraphqlDiagnosticsResponseSchema = z.object({
  query: z.array(graphqlDiagnosticWireSchema),
  variables: z.array(graphqlDiagnosticWireSchema),
  operations: z.array(z.string()),
});
export type RequestGraphqlDiagnosticsResponse = z.infer<typeof requestGraphqlDiagnosticsResponseSchema>;

/** Request payload for `request.graphqlComplete`: which editor, and where its caret is. */
export const requestGraphqlCompleteRequestSchema = graphqlAssistBaseSchema.extend({
  target: z.enum(['query', 'variables']),
  line: z.number(),
  column: z.number(),
});
export type RequestGraphqlCompleteRequest = z.infer<typeof requestGraphqlCompleteRequestSchema>;

export const graphqlCompletionItemWireSchema = z.object({
  label: z.string(),
  kind: z.enum(['field', 'type', 'argument', 'variable', 'fragment', 'directive', 'enum', 'keyword', 'other']),
  detail: z.string().optional(),
  documentation: z.string().optional(),
  insertText: z.string().optional(),
});
export type GraphqlCompletionItemWire = z.infer<typeof graphqlCompletionItemWireSchema>;

export const requestGraphqlCompleteResponseSchema = z.object({ items: z.array(graphqlCompletionItemWireSchema) });
export type RequestGraphqlCompleteResponse = z.infer<typeof requestGraphqlCompleteResponseSchema>;

/** Request payload for `request.graphqlHover`. */
export const requestGraphqlHoverRequestSchema = graphqlAssistBaseSchema.extend({
  line: z.number(),
  column: z.number(),
});
export type RequestGraphqlHoverRequest = z.infer<typeof requestGraphqlHoverRequestSchema>;

/** Response for `request.graphqlHover`: Markdown, or `null` when there is nothing to show. */
export const requestGraphqlHoverResponseSchema = z.object({ markdown: z.string().nullable() });
export type RequestGraphqlHoverResponse = z.infer<typeof requestGraphqlHoverResponseSchema>;
