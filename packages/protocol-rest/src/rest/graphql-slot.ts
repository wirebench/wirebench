/**
 * GraphQL as REST sees it (phase 6 spec §3.2). A GraphQL body is a REST body kind on disk, and REST
 * still loads, saves and scans it; what the body means — the JSON it is sent as, the API's schema,
 * the check its response gets — is `@wirebench/protocol-graphql`'s, which the composition installs
 * here, as it fills core's default-registry slot (package split spec §3.3). REST imports no other
 * protocol (ADR-0030), so the contract is written out below and the composition is where the
 * compiler checks that the package meets it.
 */
import type { AssertionResult } from '#core/assert/model';
import { WirebenchError } from '#core/errors';
import type { RestBody } from './model.js';

/** The feature a GraphQL body's sends need. */
export const GRAPHQL_FEATURE_ID = 'graphql';

type GraphqlBody = Extract<RestBody, { kind: 'graphql' }>;

/** The raw JSON body a GraphQL body is sent as. */
export interface LoweredGraphqlBody {
  readonly kind: 'raw';
  readonly language: 'json';
  readonly text: string;
}

/** A GraphQL response checked: the shape REST carries on its exchange and reports from. */
export interface RestGraphqlCheck {
  readonly errors: readonly {
    readonly message: string;
    readonly path?: readonly (string | number)[];
    readonly pointer: string;
  }[];
  readonly problems: readonly { readonly pointer: string; readonly message: string }[];
  readonly schema: 'checked' | 'no-schema' | 'no-query' | 'skipped' | 'not-graphql';
}

/**
 * What REST needs of GraphQL. The schema is opaque to REST: it reads one and hands it back.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface RestGraphqlSupport {
  lower(body: GraphqlBody): LoweredGraphqlBody;
  lowerText(body: GraphqlBody): LoweredGraphqlBody;
  readSchema(projectDir: string, apiSlug: string): Promise<unknown>;
  checkSent(sentBody: string | undefined, responseText: string, schema: unknown): RestGraphqlCheck;
  errorsCheck(result: RestGraphqlCheck): AssertionResult;
}

let installed: RestGraphqlSupport | undefined;

/**
 * Installs GraphQL; the composition calls it once when it is loaded.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function installRestGraphql(support: RestGraphqlSupport): void {
  installed = support;
}

/**
 * The installed GraphQL.
 *
 * @throws WirebenchError `feature-disabled` when this build composed none
 */
export function restGraphql(): RestGraphqlSupport {
  if (installed === undefined) {
    throw new WirebenchError('feature-disabled', 'This build has no GraphQL', {
      details: { feature: GRAPHQL_FEATURE_ID },
    });
  }
  return installed;
}
