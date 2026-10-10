/**
 * Picking a response for a routed request (spec §Dispatch): the operation's candidates in the current
 * scenario states, one style to choose among them, then the default.
 *
 * Match conditions and scripts are asynchronous (they run on workers); the choice itself, the sequence
 * counter and every scenario change are made synchronously once that work is done, so two concurrent
 * requests never take one sequence slot or interleave a scenario move.
 */

import { randomInt } from 'node:crypto';
import type { QueryResult } from '../xpath/evaluate.js';
import { evaluateWithTimeout, matchRegexWithTimeout } from '../xpath/evaluate-async.js';
import { parseXml } from '../xml/parse.js';
import { collectNamespaces } from '../xpath/namespaces.js';
import type { MockProblem, MockRequest, MockRequestView } from './contract.js';
import { SCENARIO_START_STATE } from './model.js';
import type { MockMatch, MockOperation, MockResponse, MockTemplateValue } from './model.js';

/** The state of one running mock: scenario states and sequence counters. */
export class MockState {
  readonly #scenarios = new Map<string, string>();
  readonly #counters = new Map<string, number>();

  /** The scenario's current state; every scenario starts in {@link SCENARIO_START_STATE}. */
  scenario(name: string): string {
    return this.#scenarios.get(name) ?? SCENARIO_START_STATE;
  }

  setScenario(name: string, state: string): void {
    this.#scenarios.set(name, state);
  }

  /** Every scenario that has left its start state. */
  scenarios(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.#scenarios);
  }

  /** The operation's next sequence slot, advanced. */
  takeSlot(operationId: string): number {
    const slot = this.#counters.get(operationId) ?? 0;
    this.#counters.set(operationId, slot + 1);
    return slot;
  }

  reset(): void {
    this.#scenarios.clear();
    this.#counters.clear();
  }
}

/** The responses that may be sent now: in order, and in their scenario's state when they name one. */
export function candidates(operation: MockOperation, state: MockState): MockResponse[] {
  return operation.responses.filter(
    (response) =>
      response.scenario?.state === undefined || state.scenario(response.scenario.name) === response.scenario.state,
  );
}

/** What a dispatch script decided. */
export type ScriptDecision =
  | {
      readonly ok: true;
      /** The response's name, or undefined to use the default. */
      readonly response?: string;
      /** Scenario states the script set, applied before the response's own `next`. */
      readonly scenarios: Readonly<Record<string, string>>;
      readonly log: readonly string[];
    }
  | { readonly ok: false; readonly message: string; readonly log: readonly string[] };

/** Runs an operation's dispatch script over the request and the candidates. */
export type DispatchScriptRunner = (input: {
  readonly operation: MockOperation;
  readonly operationKey: string;
  readonly request: MockRequest;
  readonly view: MockRequestView;
  readonly candidates: readonly MockResponse[];
  readonly state: MockState;
}) => Promise<ScriptDecision>;

export interface DispatchDeps {
  /** A uniformly random integer in `[0, n)`; `crypto.randomInt` unless a test seeds it. */
  readonly random?: (n: number) => number;
  /** Absent: a `script` operation fails with `mock-script-failed`. */
  readonly script?: DispatchScriptRunner;
}

/** The outcome of {@link dispatch}. */
export type DispatchResult =
  | {
      readonly ok: true;
      readonly response: MockResponse;
      readonly problems: readonly MockProblem[];
      readonly log?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: 'mock-no-stub' | 'mock-no-response' | 'mock-script-failed';
      readonly message: string;
      readonly problems: readonly MockProblem[];
      readonly log?: readonly string[];
    };

function defaultOf(operation: MockOperation): MockResponse | undefined {
  return operation.defaultResponseId === undefined
    ? undefined
    : operation.responses.find((response) => response.id === operation.defaultResponseId);
}

/** Moves the response's scenario on; called once the response is certain to be sent. */
function commit(response: MockResponse, state: MockState): void {
  const scenario = response.scenario;
  if (scenario?.next !== undefined) {
    state.setScenario(scenario.name, scenario.next);
  }
}

function fallback(
  operation: MockOperation,
  state: MockState,
  problems: readonly MockProblem[],
  log?: readonly string[],
): DispatchResult {
  const chosen = defaultOf(operation);
  if (chosen !== undefined) {
    commit(chosen, state);
    return { ok: true, response: chosen, problems, ...(log !== undefined ? { log } : {}) };
  }
  return operation.responses.length === 0
    ? { ok: false, code: 'mock-no-stub', message: `The operation "${operation.name}" has no responses`, problems }
    : {
        ok: false,
        code: 'mock-no-response',
        message: `No response of "${operation.name}" applies to this request, and it has no default`,
        problems,
        ...(log !== undefined ? { log } : {}),
      };
}

/**
 * Picks the response for one routed request and applies its scenario move. Never rejects.
 *
 * @param operationKey the contract operation's key, which a script sees as `request.operation`
 */
export async function dispatch(
  operation: MockOperation,
  operationKey: string,
  request: MockRequest,
  view: MockRequestView,
  state: MockState,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  switch (operation.dispatch) {
    case 'sequence': {
      const now = candidates(operation, state);
      if (now.length === 0) return fallback(operation, state, []);
      const chosen = now[state.takeSlot(operation.id) % now.length] as MockResponse;
      commit(chosen, state);
      return { ok: true, response: chosen, problems: [] };
    }
    case 'random': {
      const now = candidates(operation, state);
      if (now.length === 0) return fallback(operation, state, []);
      const chosen = now[(deps.random ?? randomInt)(now.length)] as MockResponse;
      commit(chosen, state);
      return { ok: true, response: chosen, problems: [] };
    }
    case 'match': {
      const problems: MockProblem[] = [];
      const held = new Map<string, boolean>();
      for (const response of candidates(operation, state)) {
        const holds = await allHold(response.match, request, view, problems);
        held.set(response.id, holds);
        if (holds) break;
      }
      // The states may have moved while the conditions ran: choose among the candidates of now.
      const chosen = candidates(operation, state).find((response) => held.get(response.id) === true);
      if (chosen === undefined) return fallback(operation, state, problems);
      commit(chosen, state);
      return { ok: true, response: chosen, problems };
    }
    case 'script': {
      if (deps.script === undefined || operation.script === undefined) {
        return {
          ok: false,
          code: 'mock-script-failed',
          message: `The operation "${operation.name}" dispatches by script but has no dispatch.ts`,
          problems: [],
        };
      }
      const offered = candidates(operation, state);
      const decision = await deps.script({ operation, operationKey, request, view, candidates: offered, state });
      if (!decision.ok) {
        return { ok: false, code: 'mock-script-failed', message: decision.message, problems: [], log: decision.log };
      }
      for (const [name, value] of Object.entries(decision.scenarios)) {
        state.setScenario(name, value);
      }
      if (decision.response === undefined) return fallback(operation, state, [], decision.log);
      const chosen = offered.find((response) => response.name === decision.response);
      if (chosen === undefined) {
        return {
          ok: false,
          code: 'mock-script-failed',
          message: `The script chose "${decision.response}", which is not a response of "${operation.name}" in the current scenario states`,
          problems: [],
          log: decision.log,
        };
      }
      commit(chosen, state);
      return { ok: true, response: chosen, problems: [], log: decision.log };
    }
  }
}

async function allHold(
  conditions: readonly MockMatch[],
  request: MockRequest,
  view: MockRequestView,
  problems: MockProblem[],
): Promise<boolean> {
  for (const condition of conditions) {
    if (!(await holds(condition, request, view, problems))) {
      return false;
    }
  }
  return true;
}

/** What one condition or template value read: whether there is a value, and its text. */
export interface Read {
  readonly found: boolean;
  readonly value: string;
}

/**
 * Reads the value a match condition or a template value names from the request. Checks are not applied
 * here. Resolves to `undefined` when a body expression failed, with the failure in `problems`.
 */
export async function readRequestValue(
  condition: MockMatch | MockTemplateValue,
  request: MockRequest,
  view: MockRequestView,
  problems: MockProblem[],
): Promise<Read | undefined> {
  switch (condition.from) {
    case 'query': {
      const values = Object.hasOwn(request.query, condition.name) ? request.query[condition.name] : undefined;
      return { found: values !== undefined && values.length > 0, value: values?.[0] ?? '' };
    }
    case 'header': {
      const wanted = condition.name.toLowerCase();
      const pair = request.headers.find(([name]) => name.toLowerCase() === wanted);
      return { found: pair !== undefined, value: pair?.[1] ?? '' };
    }
    case 'path': {
      const value = Object.hasOwn(view.pathParams, condition.name) ? view.pathParams[condition.name] : undefined;
      return { found: value !== undefined, value: value ?? '' };
    }
    case 'body': {
      const json = condition.language === 'jsonpath';
      if (json ? view.bodyKind !== 'json' : view.bodyKind !== 'xml') {
        return { found: false, value: '' };
      }
      const namespaces = condition.namespaces ?? (json ? undefined : collectNamespaces(request.bodyText));
      const result = await evaluateWithTimeout(
        request.bodyText,
        condition.expression,
        { language: condition.language, ...(namespaces !== undefined ? { namespaces } : {}) },
        { kind: json ? 'json' : 'xml' },
      );
      if (result.kind === 'error') {
        problems.push({
          code: 'mock-match-failed',
          message: `${condition.language} ${condition.expression}: ${result.message}`,
        });
        return undefined;
      }
      return { found: result.kind !== 'empty', value: stringValue(result) };
    }
  }
}

/**
 * The first item's string value: an element's text content rather than its markup, so `equals: SKU-0`
 * on `//sku` compares what the element holds. Attributes, text nodes and atomic values are already text.
 */
function stringValue(result: QueryResult): string {
  if (result.kind === 'nodes') {
    const item = result.items[0];
    if (item === undefined) return '';
    if (item.nodeKind !== 'element') return item.text;
    try {
      return parseXml(item.text).documentElement?.textContent ?? '';
    } catch {
      return item.text;
    }
  }
  return result.kind === 'values' ? (result.items[0]?.text ?? '') : '';
}

async function holds(
  condition: MockMatch,
  request: MockRequest,
  view: MockRequestView,
  problems: MockProblem[],
): Promise<boolean> {
  const got = await readRequestValue(condition, request, view, problems);
  if (got === undefined) {
    return false;
  }
  const checked = condition.exists !== undefined || condition.equals !== undefined || condition.matches !== undefined;
  if (!checked) {
    return got.found;
  }
  if (condition.exists !== undefined && got.found !== condition.exists) {
    return false;
  }
  if (condition.equals !== undefined && (!got.found || got.value !== condition.equals)) {
    return false;
  }
  if (condition.matches !== undefined) {
    if (!got.found) return false;
    const matched = await matchRegexWithTimeout(condition.matches, got.value);
    if (matched.kind === 'error') {
      problems.push({ code: 'mock-match-failed', message: `/${condition.matches}/: ${matched.message}` });
      return false;
    }
    return matched.matched;
  }
  return true;
}
