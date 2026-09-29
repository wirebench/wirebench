import { callbackLabel } from './model.js';
import type { AssertionResult, AssertionSubject, StepAssertion } from './model.js';
import { evaluateContract } from './contract.js';
import { evaluateHeader } from './header.js';
import { evaluateMatch } from './match.js';
import { evaluateSla } from './sla.js';
import { evaluateSoapFault } from './soap-fault.js';
import { evaluateStatus } from './status.js';

function evaluateOne(subject: AssertionSubject, assertion: StepAssertion): Promise<AssertionResult> | AssertionResult {
  switch (assertion.type) {
    case 'status':
      return evaluateStatus(subject, assertion);
    case 'soap-fault':
      return evaluateSoapFault(subject, assertion);
    case 'sla':
      return evaluateSla(subject, assertion);
    case 'match':
      return evaluateMatch(subject, assertion);
    case 'schema':
      return evaluateContract(subject, assertion);
    case 'header':
      return evaluateHeader(subject, assertion);
    case 'callback':
      // Waiting needs the send's moment and a capture source: only a run has them (`assert/callback.ts`).
      return {
        type: 'callback',
        label: callbackLabel(assertion),
        outcome: 'errored',
        message: 'a callback assertion is checked by a run, after its send',
      };
  }
}

/** Evaluates every assertion, in order. One failing or erroring never stops the rest. */
export async function evaluateAssertions(
  subject: AssertionSubject,
  assertions: readonly StepAssertion[],
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const assertion of assertions) {
    results.push(await evaluateOne(subject, assertion));
  }
  return results;
}

export type * from './model.js';
