/**
 * A request's own assertions checked against what came back (request-assertions spec §4): the one
 * check a run and the desktop's editor Send share.
 */
import { isCallbackAssertion } from './callback.js';
import { evaluateAssertions } from './index.js';
import type { Assertion, AssertionResult, AssertionSubject } from './model.js';

/**
 * Checks `assertions` against `subject`, in order. A run's default SLA joins them when the request
 * has no `sla` of its own. Callback assertions are left out: only a run waits for a callback.
 */
export async function checkRequestAssertions(
  subject: AssertionSubject,
  assertions: readonly Assertion[],
  options: { readonly defaultSlaMs?: number } = {},
): Promise<AssertionResult[]> {
  const withDefault: readonly Assertion[] =
    options.defaultSlaMs !== undefined && !assertions.some((a) => a.type === 'sla')
      ? [...assertions, { type: 'sla', maxMs: options.defaultSlaMs }]
      : assertions;
  return [
    ...(await evaluateAssertions(
      subject,
      withDefault.filter((a) => !isCallbackAssertion(a)),
    )),
  ];
}
