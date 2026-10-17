/**
 * A request's scripts in a send (spec §Results): which ones run, the type check before the send,
 * and the pre-request and post-response runs. The run (`run/run.ts`) and the app's send paths both
 * go through this, so a script behaves the same in a pipeline and on a click.
 *
 * A request's scripts include those of the levels above it (#334): its API's or interface's, then
 * each enclosing folder's from the outermost in, then its own. Each level is checked and run as a
 * script of its own, with its own file, secrets and timeout.
 */
import { createHash } from 'node:crypto';
import { WirebenchError } from '../errors.js';
import type { RequestSnapshotBase, ResponseSnapshotBase } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import type { ScriptChecker, ScriptDiagnostic } from './check/host.js';
import {
  isLayeredApi,
  scriptFileName,
  type RequestScripts,
  type ScriptFailure,
  type ScriptOutcome,
  type ScriptPhase,
  type ScriptSource,
} from './model.js';
import { runScript } from './run.js';
import type { ScriptSandbox } from './sandbox/host.js';
import { scriptingOf } from './lookup.js';
import { scriptDeclarations } from './types/api.js';

/** The generated half of a request's script types, and what its module needs for typed views. */
export interface RequestScriptTypes {
  readonly generated: string;
  /**
   * Opaque to everything but the module that produced it, which reads it back in its scripting
   * facet's `views` (SOAP: `SoapScriptBinding`).
   */
  readonly binding?: unknown;
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
 * would be sending something other than what the request says. `owner` names a level above the
 * request whose script it is (`API "Shop"`); absent, the script is the request's own.
 *
 * @throws WirebenchError `script-file-missing` | `script-too-large`
 */
export function assertScriptsUsable(scripts: RequestScripts, path: string, owner?: string): void {
  for (const [phase, source] of [
    ['pre', scripts.pre],
    ['post', scripts.post],
  ] as const) {
    if (source?.problem !== undefined) {
      const which = `${owner === undefined ? 'its' : `${owner}'s`} ${phase === 'pre' ? 'pre-request' : 'post-response'}`;
      throw new WirebenchError(
        source.problem,
        source.problem === 'script-file-missing'
          ? `"${path}": ${which} script file is missing`
          : `"${path}": ${which} script is over the size limit`,
        { details: { path, phase, ...(owner !== undefined ? { owner } : {}) } },
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
  /** Where a request's protocol is looked up; the built-in registry when absent. */
  readonly registry?: ProtocolRegistry;
}

/** Where a script sits (#334): above the request, on its API, interface or a folder, or on the request. */
export type ScriptLevelKind = 'api' | 'interface' | 'folder' | 'request';

/** The scripts of one level above a request (#334). */
export interface ScriptLevel {
  readonly level: Exclude<ScriptLevelKind, 'request'>;
  readonly name: string;
  /**
   * Its files' name before `.pre.ts`, relative to the API's or interface's directory, which errors
   * are reported against: `api`, `interface`, or a folder's slugs then `folder` (`Orders/folder`).
   */
  readonly stem: string;
  readonly scripts: RequestScripts;
}

/** One level of a request's scripts as a send runs it: a level above the request, or its own. */
export interface ScriptRunLevel {
  readonly level: ScriptLevelKind;
  readonly name: string;
  readonly stem: string;
  readonly scripts: RequestScripts;
}

/** One request's scripts, with the facts every run of them shares. */
export interface ScriptedRequest {
  readonly protocol: string;
  /** The request's path, for messages. */
  readonly path: string;
  readonly name: string;
  readonly slug: string;
  /** The request's own scripts, when they run. */
  readonly scripts?: RequestScripts;
  /** The scripts of the levels above it that run, outermost first (#334). */
  readonly outer?: readonly ScriptLevel[];
  readonly types: RequestScriptTypes;
}

/** Every level of a request's scripts, in the order they run: its levels outermost first, then its own. */
export function scriptLevels(request: ScriptedRequest): readonly ScriptRunLevel[] {
  return [
    ...(request.outer ?? []),
    ...(request.scripts !== undefined
      ? [{ level: 'request' as const, name: request.name, stem: request.slug, scripts: request.scripts }]
      : []),
  ];
}

/** The scripts of every level that will run: switched on, with a script. Outermost first. */
export function activeLevels(levels: readonly ScriptLevel[]): ScriptLevel[] {
  return levels.flatMap((level) => {
    const scripts = activeScripts(level.scripts);
    return scripts === undefined ? [] : [{ ...level, scripts }];
  });
}

/** A level above a request as a message names it: `API "Shop"`, `Folder "Orders"`. */
export function levelOwner(level: Pick<ScriptRunLevel, 'level' | 'name'>): string | undefined {
  switch (level.level) {
    case 'api':
      return `API "${level.name}"`;
    case 'interface':
      return `Interface "${level.name}"`;
    case 'folder':
      return `Folder "${level.name}"`;
    default:
      return undefined;
  }
}

/**
 * The generated half of the types a level's script is checked against (#334): none of any one
 * operation's, since a level runs for many. Empty for a protocol without scripts.
 */
export function levelScriptTypes(protocol: string, registry?: ProtocolRegistry): string {
  return scriptingOf(protocol, registry)?.levelTypes() ?? '';
}

/** Every secret any level of a request's scripts lists, once each. */
export function scriptSecretNames(request: ScriptedRequest): readonly string[] {
  return [...new Set(scriptLevels(request).flatMap((level) => level.scripts.secrets))];
}

export interface ScriptRunValues {
  readonly vars: Readonly<Record<string, string>>;
  readonly props: Readonly<Record<string, string>>;
  /** The values of the secrets the scripts list, every level's; each level reads only its own. */
  readonly secrets: Readonly<Record<string, string>>;
  /** A data-driven run's row for this iteration (#336). */
  readonly data?: Readonly<Record<string, string>>;
  /** Which iteration of a data-driven run this is. */
  readonly iteration?: { readonly index: number; readonly count: number };
}

/** Runs requests' scripts, caching each script's type check by its text and its types. */
export class RequestScripting {
  private readonly checked = new Map<string, Promise<readonly ScriptDiagnostic[]>>();

  constructor(private readonly options: RequestScriptingOptions) {}

  private diagnostics(
    request: ScriptedRequest,
    level: ScriptRunLevel,
    phase: ScriptPhase,
    source: ScriptSource,
  ): Promise<readonly ScriptDiagnostic[]> {
    const checker = this.options.checker;
    if (checker === undefined) return Promise.resolve([]);
    const api = level.scripts.api;
    const generated =
      level.level === 'request' ? request.types.generated : levelScriptTypes(request.protocol, this.options.registry);
    const declarations = isLayeredApi(api)
      ? ''
      : scriptDeclarations(request.protocol, phase, level.scripts.secrets, generated, this.options.registry);
    const key = createHash('sha256')
      .update(api)
      .update('\0')
      .update(source.text)
      .update('\0')
      .update(declarations)
      .digest('hex');
    let found = this.checked.get(key);
    if (found === undefined) {
      found = checker.check({ source: source.text, declarations, api });
      found.catch(() => this.checked.delete(key));
      this.checked.set(key, found);
    }
    return found;
  }

  /**
   * Type-checks every level of a request's scripts (syntax only for a layered one).
   *
   * @throws WirebenchError `script-type-error` (or `script-syntax-error` when only layered scripts
   * fail), `script-file-missing`, `script-too-large`
   */
  async check(request: ScriptedRequest): Promise<void> {
    const levels = scriptLevels(request);
    for (const level of levels) assertScriptsUsable(level.scripts, request.path, levelOwner(level));
    const errors: { file: string; diagnostic: ScriptDiagnostic }[] = [];
    let typed = false;
    for (const level of levels) {
      for (const phase of ['pre', 'post'] as const) {
        const source = level.scripts[phase];
        if (source === undefined) continue;
        const file = this.fileOf(level, phase);
        for (const diagnostic of await this.diagnostics(request, level, phase, source)) {
          if (diagnostic.severity !== 'error') continue;
          errors.push({ file, diagnostic });
          typed ||= level.scripts.api === 'wirebench';
        }
      }
    }
    if (errors.length > 0) {
      const error = typeCheckError(request.path, errors);
      throw typed ? error : new WirebenchError('script-syntax-error', error.message, { details: error.details ?? {} });
    }
  }

  /**
   * Runs one level's script for one phase. A pre-request script's failure is returned, as a
   * post-response one's is: the caller decides what stops (`run/script-support.ts`).
   */
  runLevel(
    request: ScriptedRequest,
    level: ScriptRunLevel,
    phase: ScriptPhase,
    snapshot: RequestSnapshotBase,
    response: ResponseSnapshotBase | undefined,
    values: ScriptRunValues,
    layer?: string,
  ): Promise<ScriptOutcome> {
    const source = level.scripts[phase];
    if (source === undefined) throw new Error(`No ${phase} script`);
    const secrets = Object.fromEntries(
      level.scripts.secrets.flatMap((name) => {
        const value = values.secrets[name];
        return value === undefined ? [] : [[name, value] as const];
      }),
    );
    return runScript({
      sandbox: this.options.sandbox,
      phase,
      api: level.scripts.api,
      source: source.text,
      filename: this.fileOf(level, phase),
      ...(level.scripts.timeoutMs !== undefined ? { timeoutMs: level.scripts.timeoutMs } : {}),
      request: snapshot,
      ...(response !== undefined ? { response } : {}),
      vars: values.vars,
      props: values.props,
      secrets,
      ...(values.data !== undefined ? { data: values.data } : {}),
      ...(values.iteration !== undefined ? { iteration: values.iteration } : {}),
      requestName: request.name,
      ...(layer !== undefined ? { layer } : {}),
      ...(this.options.onSecretValue !== undefined ? { onSecretValue: this.options.onSecretValue } : {}),
      // Every level sees the request's typed views; only its check is generic.
      ...(request.types.binding !== undefined ? { binding: request.types.binding } : {}),
      ...(this.options.registry !== undefined ? { registry: this.options.registry } : {}),
    });
  }

  /** The file name errors in a level's script for a phase are reported against. */
  fileOf(level: Pick<ScriptRunLevel, 'stem' | 'scripts'>, phase: ScriptPhase): string {
    return scriptFileName(level.stem, phase, level.scripts.api);
  }
}
