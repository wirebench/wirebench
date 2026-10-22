/**
 * Where a description comes from.
 *
 * In `json/schema/` because the OpenAPI and the AsyncAPI imports take the same three sources, and no
 * protocol folder imports another (protocol modules spec §7.2). `rest/openapi/import.ts` re-exports
 * the type under the name it has always had.
 */

/** Where a document comes from: a location to fetch, or text the user already has. */
export type OpenApiSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string }
  /** Text with a location to resolve relative references against — a paste, or a test. */
  | { readonly kind: 'text'; readonly text: string; readonly location?: string };
