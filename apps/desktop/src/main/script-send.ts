/**
 * A request's scripts in one of the app's sends (#63): the lookup, the values a send starts from,
 * and what is done with what the scripts did. The engine runs them (`send/exchange.ts` hands it
 * the session).
 *
 * The order is the run's (spec §What a pre-request script can change): the request is resolved with
 * its secrets behind placeholders, the pre-request script runs on that, the placeholders are put
 * back, and only then do auth, TLS, the proxy, WS-Addressing and WS-Security apply. The
 * post-response script runs before the summary, the HTTP Log row and the History entry are built,
 * so a value it marks secret is masked in all three.
 *
 * Where the values go (spec §Values): a sequence step hands them to the run (`onScriptsRan`); a
 * single send keeps them in its project's session, which `${#Sequence#name}` reads outside a run.
 */

import type { PropertyMap, RequestScripting, ScriptValue, SentScripts } from '@wirebench/engine';
import type { ScriptLookup } from './script-host.js';
import { redactSecretText } from './redact.js';
import type { ScriptResultWire } from '../shared/wire-types.js';

/** What a send needs of the app's script host. */
export interface SendScripts {
  lookup(requestId: string): Promise<ScriptLookup>;
  readonly scripting: RequestScripting;
  sessionValues(projectId: string): PropertyMap;
  keepValues(projectId: string, values: readonly ScriptValue[]): void;
}

/** The part of a send path's dependencies scripts read. */
export interface ScriptSendDeps {
  /** Omitted in tests that send no scripted request; a request with scripts then refuses to send. */
  readonly scripts?: SendScripts;
  /**
   * Told what a send's scripts did, in place of keeping their values in the session. Only a
   * sequence step sets it: its values belong to its run.
   */
  readonly onScriptsRan?: (sent: SentScripts) => void;
}

const NONE: ScriptLookup = { kind: 'none' };

/**
 * Whether this send runs scripts. A request whose scripts are switched on is type-checked here,
 * before anything is resolved or sent.
 *
 * @throws WirebenchError `script-unavailable` when the request has scripts and there is no host;
 * `script-type-error`, `script-syntax-error`, `script-file-missing`, `script-too-large`
 */
export async function scriptsForSend(deps: ScriptSendDeps, requestId: string | undefined): Promise<ScriptLookup> {
  if (requestId === undefined || deps.scripts === undefined) return NONE;
  const lookup = await deps.scripts.lookup(requestId);
  if (lookup.kind === 'on') await deps.scripts.scripting.check(lookup.request);
  return lookup;
}

/** The session values a single send of a project's request expands `${#Sequence#…}` against. */
export function sessionValuesFor(deps: ScriptSendDeps, projectId: string | undefined): PropertyMap | undefined {
  if (projectId === undefined || deps.scripts === undefined || deps.onScriptsRan !== undefined) return undefined;
  return deps.scripts.sessionValues(projectId);
}

/** A post-response run that could not finish, as what the scripts did. */
export function scriptsFailed(error: unknown): SentScripts {
  return {
    tests: [],
    values: [],
    log: { lines: [], truncated: false },
    error: { code: 'script-error', message: error instanceof Error ? error.message : String(error) },
  };
}

const mask = (text: string): string => redactSecretText(text, { show: false });

/** What a send's scripts did, as its summary carries it: every string masked. */
export function toScriptResultWire(sent: SentScripts): ScriptResultWire {
  return {
    tests: sent.tests.map((test) => ({
      name: mask(test.name),
      passed: test.passed,
      ...(test.message !== undefined ? { message: mask(test.message) } : {}),
    })),
    log: sent.log.lines.map(mask),
    truncated: sent.log.truncated,
    ...(sent.error !== undefined ? { error: { code: sent.error.code, message: mask(sent.error.message) } } : {}),
  };
}

/** Hands a send's script values to the run, or keeps them in the session; the summary's `script`. */
export function finishScripts(
  deps: ScriptSendDeps,
  projectId: string | undefined,
  sent: SentScripts,
): { readonly script: ScriptResultWire } {
  if (deps.onScriptsRan !== undefined) {
    deps.onScriptsRan(sent);
  } else if (projectId !== undefined) {
    deps.scripts?.keepValues(projectId, sent.values);
  }
  return { script: toScriptResultWire(sent) };
}
