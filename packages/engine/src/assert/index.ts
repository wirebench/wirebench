import type { Assertion, AssertionResult, AssertionSubject } from './model.js';
import { evaluateMatch } from './match.js';
import { evaluateSla } from './sla.js';
import { evaluateSoapFault } from './soap-fault.js';
import { evaluateStatus } from './status.js';

function evaluateOne(subject: AssertionSubject, assertion: Assertion): Promise<AssertionResult> | AssertionResult {
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
      return {
        type: assertion.type,
        label: assertion.name ?? assertion.type,
        outcome: 'errored',
        message: 'not implemented',
      };
  }
}

/** Evaluates every assertion, in order. One failing or erroring never stops the rest. */
export async function evaluateAssertions(
  subject: AssertionSubject,
  assertions: readonly Assertion[],
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const assertion of assertions) {
    results.push(await evaluateOne(subject, assertion));
  }
  return results;
}

export type * from './model.js';
