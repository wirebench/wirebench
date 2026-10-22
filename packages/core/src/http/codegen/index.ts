/**
 * A request as code: one generator per language, all over the same {@link CodeRequest}.
 *
 * `curl` is not here: it has its own exporter (`http/curl.ts`), which the Code panel keeps using for
 * its two shell entries.
 */

import { csharpHttpClient } from './csharp.js';
import { goNetHttp } from './go.js';
import { javaHttpClient, javaOkHttp } from './java.js';
import { jsFetch, nodeAxios } from './js.js';
import type { CodeOptions, CodeRequest, CodeTargetId, GeneratedCode } from './model.js';
import { phpCurl, rubyNetHttp } from './php.js';
import { pythonRequests } from './python.js';
import { httpie, powershellIrm } from './shell.js';
import type { Target } from './target.js';
import { indentUnit } from './text.js';

const TARGETS: Readonly<Record<CodeTargetId, { readonly generate: Target; readonly indent: number | 'tab' }>> = {
  'js-fetch': { generate: jsFetch, indent: 2 },
  'node-axios': { generate: nodeAxios, indent: 2 },
  'python-requests': { generate: pythonRequests, indent: 4 },
  'go-net-http': { generate: goNetHttp, indent: 'tab' },
  'java-httpclient': { generate: javaHttpClient, indent: 4 },
  'java-okhttp': { generate: javaOkHttp, indent: 4 },
  'csharp-httpclient': { generate: csharpHttpClient, indent: 4 },
  'php-curl': { generate: phpCurl, indent: 4 },
  'ruby-net-http': { generate: rubyNetHttp, indent: 2 },
  'powershell-irm': { generate: powershellIrm, indent: 4 },
  httpie: { generate: httpie, indent: 2 },
};

/** The indent a target uses when the user has not chosen one: its language's own convention. */
export function defaultIndent(target: CodeTargetId): number | 'tab' {
  return TARGETS[target].indent;
}

/**
 * `request` as code in `target`. A setting the user left unset takes the request's own value; a
 * timeout of 0 means none.
 */
export function generateCode(target: CodeTargetId, request: CodeRequest, options: CodeOptions = {}): GeneratedCode {
  const entry = TARGETS[target];
  const followRedirects = options.followRedirects ?? request.followRedirects;
  const timeoutMs = options.timeoutMs ?? request.timeoutMs;
  return entry.generate(request, {
    unit: indentUnit(options.indent ?? entry.indent),
    followRedirects,
    ...(followRedirects && request.maxRedirects !== undefined ? { maxRedirects: request.maxRedirects } : {}),
    ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs } : {}),
  });
}

export { CODE_TARGETS, envMarker, secretTokensToEnv, splitEnv } from './model.js';
export type { CodeBody, CodeHeader, CodeOptions, CodeRequest, CodeTargetId, GeneratedCode, TextPart } from './model.js';
