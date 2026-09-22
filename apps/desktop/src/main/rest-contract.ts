/**
 * Deciding whether a REST response is checked against its OpenAPI contract, and with what.
 *
 * The project host says which operation a request calls and hands over that operation's declared
 * responses (read from the API's definition cache, never the network); the engine service's worker
 * does the checking. This module sits between them: only a JSON body that is not a stream is
 * checked, only the selected operation's `responses` are posted to the worker, and a definition
 * cache that cannot be read costs one console line and a `no-contract` result — never the send.
 */
import type { OpenApiResponses, RestContractInput, RestContractResult, RestOperationRef } from '@wirebench/engine';

/**
 * What a request is checked against: the operation it calls and that operation's declared
 * responses. An empty target — no operation matched, or it declares no responses — is `no-contract`.
 */
export interface RestContractTarget {
  readonly operation?: RestOperationRef;
  readonly responses?: OpenApiResponses;
}

/** The parts of a received response a check reads. */
export interface RestContractResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly language: string;
  readonly streamed: boolean;
}

const NO_CONTRACT: RestContractResult = { status: 'no-contract', problems: [], notes: [] };

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/**
 * The response's contract result, or `undefined` when nothing is to be checked: the request's API
 * has no cached definition (`target` is `undefined`), or the response is a stream or not JSON.
 * Never rejects: the checker itself never does, and a failed cache read degrades to `no-contract`.
 */
export async function restContractOf(
  response: RestContractResponse,
  target: Promise<RestContractTarget | undefined> | undefined,
  check: (input: RestContractInput) => Promise<RestContractResult>,
  warn: (message: string) => void = (message) => {
    console.warn(message);
  },
): Promise<RestContractResult | undefined> {
  if (target === undefined || response.streamed || response.language !== 'json') {
    return undefined;
  }
  let resolved: RestContractTarget | undefined;
  try {
    resolved = await target;
  } catch (error) {
    warn(
      `[rest] the API's definition cache could not be read, so the response is not checked: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return NO_CONTRACT;
  }
  if (resolved === undefined) {
    return undefined;
  }
  const { operation, responses } = resolved;
  if (operation === undefined || responses === undefined) {
    return operation === undefined ? NO_CONTRACT : { ...NO_CONTRACT, operation };
  }
  return check({
    status: response.status,
    contentType: headerValue(response.headers, 'content-type'),
    bodyText: response.text,
    language: response.language,
    streamed: false,
    operation,
    responses,
  });
}
