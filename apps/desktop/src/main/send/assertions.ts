/**
 * A request's own assertions as an editor Send checks them (request-assertions spec §6): the
 * engine's check over the send's subject, then each callback assertion as `not-checked`, since
 * only a run waits for a callback. Every string is masked, as a sequence step's are.
 */
import { callbackLabel, checkRequestAssertions } from '@wirebench/engine';
import type { Assertion, AssertionSubject, CallbackAssertion } from '@wirebench/engine';
import type { RequestAssertionResultWire } from '../../shared/wire-types.js';
import { redactSecretText } from '../redact.js';

const mask = (text: string): string => redactSecretText(text, { show: false });

const isCallback = (assertion: Assertion): assertion is CallbackAssertion => assertion.type === 'callback';

/** The results to show, or `undefined` when the request has no assertions of its own. */
export async function editorAssertionResults(
  assertions: readonly Assertion[],
  subject: AssertionSubject,
): Promise<RequestAssertionResultWire[] | undefined> {
  if (assertions.length === 0) {
    return undefined;
  }
  let checked: RequestAssertionResultWire[];
  try {
    checked = (await checkRequestAssertions(subject, assertions)).map((result): RequestAssertionResultWire => ({
      type: result.type,
      label: mask(result.label),
      outcome: result.outcome,
      ...(result.expected !== undefined ? { expected: mask(result.expected) } : {}),
      ...(result.actual !== undefined ? { actual: mask(result.actual) } : {}),
      ...(result.message !== undefined ? { message: mask(result.message) } : {}),
    }));
  } catch (error) {
    // A check that throws is one `errored` row; the send's own result still shows (spec §7).
    checked = [
      {
        type: 'check',
        label: 'assertions',
        outcome: 'errored',
        message: mask(error instanceof Error ? error.message : String(error)),
      },
    ];
  }
  const waiting = assertions.filter(isCallback).map((assertion): RequestAssertionResultWire => ({
    type: 'callback',
    label: mask(callbackLabel(assertion)),
    outcome: 'not-checked',
    message: 'checked in runs',
  }));
  return [...checked, ...waiting];
}
