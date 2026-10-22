/**
 * Rendering a templated response for one request (ADR-0022). The rules for what a template may hold
 * are in `template.ts`; this reads the request values and puts them in.
 */

import { validateHeaderValue } from 'node:http';
import type { MockProblem, MockRequest, MockRequestView } from './contract.js';
import { readRequestValue } from './dispatch.js';
import type { MockHeader, MockResponse } from './model.js';
import { BODY_ESCAPE, fillTemplate } from './template.js';

/** A response's headers and body as they are sent for one request. */
export type RenderedResponse =
  | {
      readonly ok: true;
      readonly headers: readonly MockHeader[];
      readonly bodyText: string;
      readonly problems: readonly MockProblem[];
    }
  | {
      readonly ok: false;
      readonly code: 'mock-template-refused';
      readonly message: string;
      readonly problems: readonly MockProblem[];
    };

/**
 * Renders `response` for `request`: its declared values read from the request (a missing one is the
 * empty string), inserted once and escaped for the body's language. A header value that would hold
 * CR, LF, NUL or anything else a header may not carry refuses the reply.
 */
export async function renderResponse(
  response: MockResponse,
  request: MockRequest,
  view: MockRequestView,
): Promise<RenderedResponse> {
  if (response.values === undefined) {
    return { ok: true, headers: response.headers, bodyText: response.bodyText, problems: [] };
  }
  const problems: MockProblem[] = [];
  const values = new Map<string, string>();
  for (const [name, source] of Object.entries(response.values)) {
    const read = await readRequestValue(source, request, view, problems);
    values.set(name, read?.found === true ? read.value : '');
  }
  const headers: MockHeader[] = [];
  for (const header of response.headers) {
    const value = fillTemplate(header.value, values, (raw) => raw);
    try {
      validateHeaderValue(header.name, value);
    } catch {
      return {
        ok: false,
        code: 'mock-template-refused',
        message: `The request value inserted into the ${header.name} header holds a character a header may not carry`,
        problems,
      };
    }
    headers.push({ name: header.name, value });
  }
  const bodyText = response.body === 'none' ? '' : fillTemplate(response.bodyText, values, BODY_ESCAPE[response.body]);
  return { ok: true, headers, bodyText, problems };
}
