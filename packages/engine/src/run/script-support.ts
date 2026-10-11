/**
 * What a run needs to run a request's scripts (#63): the script's view of properties and listed
 * secrets, and the results a report shows — tests as assertions, values for later requests.
 */
import type { AssertionResult } from '../assert/model.js';
import { resolveSecretTokens, type GetSecret } from '../secrets/resolve.js';
import type { RequestSnapshotBase, ResponseSnapshotBase } from '../protocol/module.js';
import type { ScriptLog, ScriptOutcome, ScriptPhase, ScriptTest, ScriptValue } from '../script/model.js';
import {
  scriptError,
  scriptLevels,
  type RequestScripting,
  type ScriptedRequest,
  type ScriptLevelKind,
  type ScriptRunLevel,
  type ScriptRunValues,
} from '../script/request-scripts.js';

/** What one script of one level did in a send (#334). */
export interface SentScriptLevel {
  readonly level: ScriptLevelKind;
  readonly name: string;
  readonly phase: ScriptPhase;
  readonly tests: readonly ScriptTest[];
  readonly log: ScriptLog;
  /** The script failed, as its error names it: file, position and message. */
  readonly error?: { readonly code: string; readonly message: string };
}

/** What running a request's scripts produced, carried with the sent request. */
export interface SentScripts {
  /** Every level's tests, in the order they ran. */
  readonly tests: readonly ScriptTest[];
  readonly values: readonly ScriptValue[];
  readonly log: ScriptLog;
  /** A post-response script that failed: the response is kept, the request errors. The first, when several did. */
  readonly error?: { readonly code: string; readonly message: string };
  /** Each script that ran, in order: the API's or interface's, each folder's, then the request's (#334). */
  readonly levels: readonly SentScriptLevel[];
}

/** The values of the secrets a request's scripts list. */
export async function listedSecrets(names: readonly string[], getSecret: GetSecret): Promise<Record<string, string>> {
  return names.length === 0 ? {} : resolveSecretTokens(names, getSecret);
}

/** A script's tests as a report's assertions. */
export function scriptAssertions(tests: readonly ScriptTest[]): AssertionResult[] {
  return tests.map((test) => ({
    type: 'script',
    label: test.name,
    outcome: test.passed ? 'passed' : 'failed',
    ...(test.message !== undefined ? { message: test.message } : {}),
  }));
}

/**
 * Adds a script's values to a run's values. A value marked secret, or holding a credential the run
 * knows, is reported for masking first (ADR-0015).
 */
export function mergeScriptValues(
  target: Map<string, string>,
  values: readonly ScriptValue[],
  onSecretValue: ((value: string) => void) | undefined,
  containsKnownSecret: ((value: string) => boolean) | undefined,
): void {
  for (const { name, value, secret } of values) {
    if (secret || containsKnownSecret?.(value) === true) onSecretValue?.(value);
    target.set(name, value);
  }
}

/** One send's scripts: every level's pre-request script on the prepared request, its post-response scripts on the response. */
export interface ScriptSession {
  /**
   * Runs the pre-request scripts on `before`, outermost level first, each on what the one before
   * handed back; the request as it will be sent. The first failure stops the chain.
   *
   * @throws WirebenchError the script's failure: the request is not sent
   */
  readonly pre: <S extends RequestSnapshotBase>(before: S) => Promise<S>;
  /**
   * Runs the post-response scripts, outermost level first, and returns what every script did. Each
   * sees the values every script before it set. A failure is returned, not thrown, and the later
   * levels still run (#334): the response is kept, and each level's checks stand on their own.
   */
  readonly post: (sent: RequestSnapshotBase, response: ResponseSnapshotBase) => Promise<SentScripts>;
}

export interface ScriptSessionOptions {
  /** Told each value a script sets that is secret, or holds a known secret, as soon as it is set. */
  readonly onSecretValue?: (value: string) => void;
  readonly containsKnownSecret?: (value: string) => boolean;
}

/**
 * The scripts of one send of `scripted`. The run and the app both send through this, so a value a
 * script marks secret is masked before anything about the send is shown, in either.
 */
export function scriptSession(
  scripting: RequestScripting,
  scripted: ScriptedRequest,
  values: ScriptRunValues,
  options: ScriptSessionOptions = {},
): ScriptSession {
  const levels = scriptLevels(scripted);
  const tests: ScriptTest[] = [];
  const set: ScriptValue[] = [];
  const lines: string[] = [];
  const ran: SentScriptLevel[] = [];
  let truncated = false;
  const now = (): ScriptRunValues => ({
    ...values,
    vars: { ...values.vars, ...Object.fromEntries(set.map((v) => [v.name, v.value])) },
  });
  const collect = (level: ScriptRunLevel, phase: ScriptPhase, outcome: ScriptOutcome): SentScriptLevel['error'] => {
    tests.push(...outcome.tests);
    set.push(...outcome.values);
    lines.push(...outcome.log.lines);
    truncated ||= outcome.log.truncated;
    for (const { value, secret } of outcome.values) {
      if (secret || options.containsKnownSecret?.(value) === true) options.onSecretValue?.(value);
    }
    const thrown = outcome.ok ? undefined : scriptError(outcome.error, scripting.fileOf(level, phase));
    const error = thrown === undefined ? undefined : { code: thrown.code, message: thrown.message };
    ran.push({
      level: level.level,
      name: level.name,
      phase,
      tests: outcome.tests,
      log: outcome.log,
      ...(error !== undefined ? { error } : {}),
    });
    return error;
  };
  return {
    pre: async (before) => {
      let current = before;
      for (const level of levels) {
        if (level.scripts.pre === undefined) continue;
        const outcome = await scripting.runLevel(scripted, level, 'pre', current, undefined, now());
        collect(level, 'pre', outcome);
        if (!outcome.ok) throw scriptError(outcome.error, scripting.fileOf(level, 'pre'));
        current = (outcome.request ?? current) as typeof before;
      }
      return current;
    },
    post: async (sent, response) => {
      let first: SentScripts['error'];
      for (const level of levels) {
        if (level.scripts.post === undefined) continue;
        const outcome = await scripting.runLevel(scripted, level, 'post', sent, response, now());
        const error = collect(level, 'post', outcome);
        first ??= error;
      }
      return {
        tests,
        values: set,
        log: { lines, truncated },
        levels: ran,
        ...(first !== undefined ? { error: first } : {}),
      };
    },
  };
}
