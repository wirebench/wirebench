/**
 * A request's scripts in a send (spec §Results): which ones run, the type check before the send,
 * and the pre-request and post-response runs. The run (`run/run.ts`) and the app's send paths both
 * go through this, so a script behaves the same in a pipeline and on a click.
 */
import { createHash } from 'node:crypto';
import { WirebenchError } from '../errors.js';
import type { ScriptChecker, ScriptDiagnostic } from './check/host.js';
import {
  scriptFileName,
  type RequestScripts,
  type RequestSnapshot,
  type ResponseSnapshot,
  type ScriptFailure,
  type ScriptOutcome,
  type ScriptPhase,
  type ScriptProtocol,
  type ScriptSource,
} from './model.js';
import { runScript, type ScriptRunInput } from './run.js';
import type { ScriptSandbox } from './sandbox/host.js';
import { scriptDeclarations } from './types/api.js';

/** The generated half of a request's script types, and what a SOAP body needs to be typed. */
export interface RequestScriptTypes {
  readonly generated: string;
  readonly soap?: ScriptRunInput['soap'];
}

/** The scripts of a request that will run: none when there are none or they are switched off. */
export function activeScripts(scripts: RequestScripts | undefined): RequestScripts | undefined {
  if (scripts === undefined || !scripts.enabled || (scripts.pre === undefined && scripts.post === undefined)) {
    return undefined;
  }
  return scripts;
}

/**
 * Refuses a request whose script file is missing or too large: sending it without that script
 * would be sending something other than what the request says.
 *
 * @throws WirebenchError `script-file-missing` | `script-too-large`
 */
export function assertScriptsUsable(scripts: RequestScripts, path: string): void {
  for (const [phase, source] of [
    ['pre', scripts.pre],
    ['post', scripts.post],
  ] as const) {
    if (source?.problem !== undefined) {
      const which = phase === 'pre' ? 'pre-request' : 'post-response';
      throw new WirebenchError(
        source.problem,
        source.problem === 'script-file-missing'
          ? `"${path}": its ${which} script file is missing`
          : `"${path}": its ${which} script is over the size limit`,
        { details: { path, phase } },
      );
    }
  }
}

/** A script failure as the error a send reports, with the script's file and position in it. */
export function scriptError(failure: ScriptFailure, filename: string): WirebenchError {
  const where =
    failure.position !== undefined
      ? `${filename}:${String(failure.position.line)}:${String(failure.position.column)}`
      : filename;
  return new WirebenchError(failure.code, `${where}: ${failure.message}`, {
    details: { file: filename, ...(failure.position !== undefined ? { ...failure.position } : {}) },
  });
}

/** A type-check failure: every error, as `file:line:column: message`. */
export function typeCheckError(
  path: string,
  errors: readonly { file: string; diagnostic: ScriptDiagnostic }[],
): WirebenchError {
  const lines = errors.map(({ file, diagnostic: d }) => `${file}:${String(d.line)}:${String(d.column)}: ${d.message}`);
  return new WirebenchError('script-type-error', `"${path}" has script type errors:\n${lines.join('\n')}`, {
    details: {
      path,
      errors: errors.map(({ file, diagnostic }) => ({
        file,
        line: diagnostic.line,
        column: diagnostic.column,
        message: diagnostic.message,
      })),
    },
  });
}

export interface RequestScriptingOptions {
  readonly sandbox: ScriptSandbox;
  /** Absent: scripts run without a type check (a host that checks them another way). */
  readonly checker?: ScriptChecker;
  /** Told every secret value a script may read, before it runs. */
  readonly onSecretValue?: (value: string) => void;
}

/** One request's scripts, with the facts every run of them shares. */
export interface ScriptedRequest {
  readonly protocol: ScriptProtocol;
  /** The request's path, for messages. */
  readonly path: string;
  readonly name: string;
  readonly slug: string;
  readonly scripts: RequestScripts;
  readonly types: RequestScriptTypes;
}

export interface ScriptRunValues {
  readonly vars: Readonly<Record<string, string>>;
  readonly props: Readonly<Record<string, string>>;
  /** The values of the secrets `scripts.secrets` lists. */
  readonly secrets: Readonly<Record<string, string>>;
}

/** Runs requests' scripts, caching each script's type check by its text and its types. */
export class RequestScripting {
  private readonly checked = new Map<string, Promise<readonly ScriptDiagnostic[]>>();

  constructor(private readonly options: RequestScriptingOptions) {}

  private filename(request: ScriptedRequest, phase: ScriptPhase): string {
    return scriptFileName(request.slug, phase, request.scripts.api);
  }

  private diagnostics(
    request: ScriptedRequest,
    phase: ScriptPhase,
    source: ScriptSource,
  ): Promise<readonly ScriptDiagnostic[]> {
    const checker = this.options.checker;
    if (checker === undefined) return Promise.resolve([]);
    const declarations =
      request.scripts.api === 'postman'
        ? ''
        : scriptDeclarations(request.protocol, phase, request.scripts.secrets, request.types.generated);
    const key = createHash('sha256')
      .update(request.scripts.api)
      .update('\0')
      .update(source.text)
      .update('\0')
      .update(declarations)
      .digest('hex');
    let found = this.checked.get(key);
    if (found === undefined) {
      found = checker.check({ source: source.text, declarations, api: request.scripts.api });
      found.catch(() => this.checked.delete(key));
      this.checked.set(key, found);
    }
    return found;
  }

  /**
   * Type-checks a request's scripts (syntax only for a Postman one).
   *
   * @throws WirebenchError `script-type-error` (or `script-syntax-error` for a Postman script)
   */
  async check(request: ScriptedRequest): Promise<void> {
    assertScriptsUsable(request.scripts, request.path);
    const errors: { file: string; diagnostic: ScriptDiagnostic }[] = [];
    for (const phase of ['pre', 'post'] as const) {
      const source = request.scripts[phase];
      if (source === undefined) continue;
      const file = this.filename(request, phase);
      for (const diagnostic of await this.diagnostics(request, phase, source)) {
        if (diagnostic.severity === 'error') errors.push({ file, diagnostic });
      }
    }
    if (errors.length > 0) {
      const error = typeCheckError(request.path, errors);
      throw request.scripts.api === 'postman'
        ? new WirebenchError('script-syntax-error', error.message, { details: error.details ?? {} })
        : error;
    }
  }

  private run(
    request: ScriptedRequest,
    phase: ScriptPhase,
    snapshot: RequestSnapshot,
    response: ResponseSnapshot | undefined,
    values: ScriptRunValues,
    layer?: string,
  ): Promise<ScriptOutcome> {
    const source = request.scripts[phase];
    if (source === undefined) throw new Error(`No ${phase} script`);
    return runScript({
      sandbox: this.options.sandbox,
      phase,
      api: request.scripts.api,
      source: source.text,
      filename: this.filename(request, phase),
      ...(request.scripts.timeoutMs !== undefined ? { timeoutMs: request.scripts.timeoutMs } : {}),
      request: snapshot,
      ...(response !== undefined ? { response } : {}),
      vars: values.vars,
      props: values.props,
      secrets: values.secrets,
      requestName: request.name,
      ...(layer !== undefined ? { layer } : {}),
      ...(this.options.onSecretValue !== undefined ? { onSecretValue: this.options.onSecretValue } : {}),
      ...(request.types.soap !== undefined ? { soap: request.types.soap } : {}),
    });
  }

  /**
   * The pre-request script's outcome. A failure is thrown: the request is not sent.
   *
   * @throws WirebenchError with the script's error code
   */
  async pre(
    request: ScriptedRequest,
    snapshot: RequestSnapshot,
    values: ScriptRunValues,
    layer?: string,
  ): Promise<Extract<ScriptOutcome, { ok: true }>> {
    const outcome = await this.run(request, 'pre', snapshot, undefined, values, layer);
    if (!outcome.ok) throw scriptError(outcome.error, this.filename(request, 'pre'));
    return outcome;
  }

  /** The post-response script's outcome; a failure is returned, since the response is kept. */
  post(
    request: ScriptedRequest,
    sent: RequestSnapshot,
    response: ResponseSnapshot,
    values: ScriptRunValues,
    layer?: string,
  ): Promise<ScriptOutcome> {
    return this.run(request, 'post', sent, response, values, layer);
  }

  /** The file name errors in a phase's script are reported against. */
  fileOf(request: ScriptedRequest, phase: ScriptPhase): string {
    return this.filename(request, phase);
  }
}
