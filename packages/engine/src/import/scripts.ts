/**
 * Scripts an importer keeps as text (spec §7.4, §6.2): written under `imported-scripts/` by the
 * desktop main process, never read back or run. The path rule here is pure.
 */
import { TOP_LEVEL_IMPORT } from '../script/api/hoppscotch.js';
import type { LayeredApi, RequestScripts } from '../script/model.js';

/** The folder imported scripts are written to. Nothing in Wirebench reads it. */
export const IMPORTED_SCRIPTS_DIR = 'imported-scripts';

export interface ImportedScriptFile {
  readonly path: string;
  readonly source: string;
}

/** `imported-scripts/<api>/<item>.<tail>`, with `-2`, `-3` before the tail for a repeat. */
export function importedScriptPath(apiSlug: string, itemSlug: string, fileTail: string, taken: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const item = n === 1 ? itemSlug : `${itemSlug}-${n}`;
    const path = `${IMPORTED_SCRIPTS_DIR}/${apiSlug}/${item}.${fileTail}`;
    if (!taken.has(path)) {
      taken.add(path);
      return path;
    }
  }
}

/** A level's scripts of one kind, in the order the client runs them; two of one kind are joined. */
export function scriptText(texts: readonly string[]): string {
  return texts.map((text) => `${text.replace(/\s+$/, '')}\n`).join('\n');
}

/**
 * The calls a script makes that its API's layer does not run (spec §Postman), found by name. Each
 * other client's list is filled by its layer.
 */
const UNSUPPORTED_CALLS: Record<LayeredApi, readonly [RegExp, string][]> = {
  postman: [
    [/\bpm\.sendRequest\b/, 'pm.sendRequest'],
    [/\bpm\.cookies\.jar\b/, 'pm.cookies.jar'],
    [/\bpm\.visualizer\b/, 'pm.visualizer'],
    [/\brequire\s*\(/, 'require'],
    [/\bpm\.iterationData\b/, 'pm.iterationData'],
    [/\bpm\.vault\b/, 'pm.vault'],
  ],
  insomnia: [
    [/(?<![\w$.])(?:insomnia|\$)\.sendRequest\b/, 'insomnia.sendRequest'],
    [/(?<![\w$.])(?:insomnia|\$)\.require\b/, 'insomnia.require'],
    [/(?<![\w$.])require\s*\(/, 'require'],
    [/(?<![\w$.])(?:insomnia|\$)\.cookies\.(?:set|unset|clear)\b/, 'insomnia.cookies writes'],
    [/(?<![\w$.])(?:insomnia|\$)\.vault\b/, 'insomnia.vault'],
  ],
  bruno: [
    [/(?<![\w$.])bru\.sendRequest\b/, 'bru.sendRequest'],
    [/(?<![\w$.])bru\.sleep\b/, 'bru.sleep'],
    [/(?<![\w$.])bru\.cookies\b/, 'bru.cookies'],
    [/(?<![\w$.])req\.setTimeout\b/, 'req.setTimeout'],
    [/(?<![\w$.])req\.getTimeout\b/, 'req.getTimeout'],
    [/(?<![\w$.])req\.setMaxRedirects\b/, 'req.setMaxRedirects'],
    [/(?<![\w$.])req\.onFail\b/, 'req.onFail'],
    [/(?<![\w$.])req\.disableParsingResponseJson\b/, 'req.disableParsingResponseJson'],
    [/(?<![\w$.])require\s*\(/, 'require'],
  ],
  hoppscotch: [
    [/(?<![\w$.])hopp\.cookies\b/, 'hopp.cookies'],
    [/(?<![\w$.])hopp\.fetch\b/, 'hopp.fetch'],
    [/(?<![\w$.])pm\.sendRequest\b/, 'pm.sendRequest'],
    [/(?<![\w$.])pm\.collectionVariables\b/, 'pm.collectionVariables'],
    [/(?<![\w$.])pm\.iterationData\b/, 'pm.iterationData'],
    [/(?<![\w$.])pm\.visualizer\b/, 'pm.visualizer'],
    [/(?<![\w$.])pm\.execution\.setNextRequest\b/, 'pm.execution.setNextRequest'],
    [/(?<![\w$.])pm\.execution\.skipRequest\b/, 'pm.execution.skipRequest'],
    [/(?<![\w$.])require\s*\(/, 'require'],
    [TOP_LEVEL_IMPORT, 'import'],
  ],
  'thunder-client': [],
};

export function unsupportedCalls(text: string, api: LayeredApi): string[] {
  return UNSUPPORTED_CALLS[api].filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}

/** The Postman calls that steer a run (#335), found by name: obeyed in API and folder runs only. */
const RUN_CONTROL_CALLS: Partial<Record<LayeredApi, readonly [RegExp, string][]>> = {
  postman: [
    [/\bpm\.execution\.setNextRequest\b/, 'pm.execution.setNextRequest'],
    [/\bpostman\.setNextRequest\b/, 'postman.setNextRequest'],
    [/\bpm\.execution\.skipRequest\b/, 'pm.execution.skipRequest'],
  ],
  insomnia: [
    [/(?<![\w$.])(?:insomnia|\$)\.execution\.setNextRequest\b/, 'insomnia.execution.setNextRequest'],
    [/(?<![\w$.])(?:insomnia|\$)\.execution\.skipRequest\b/, 'insomnia.execution.skipRequest'],
  ],
  bruno: [
    [/(?<![\w$.])bru\.setNextRequest\b/, 'bru.setNextRequest'],
    [/(?<![\w$.])bru\.runner\.skipRequest\b/, 'bru.runner.skipRequest'],
    [/(?<![\w$.])bru\.runner\.stopExecution\b/, 'bru.runner.stopExecution'],
  ],
};

export function runControlCalls(text: string, api: LayeredApi = 'postman'): string[] {
  return (RUN_CONTROL_CALLS[api] ?? []).filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}

/** The level of a project tree a script sits on. */
export type ScriptLevel = 'api' | 'folder' | 'request';

/**
 * What an import attached, level by level, and the report lines it owes: one line naming where
 * scripts were switched off, and one per script for the calls its layer does not run or that steer
 * a run. Every importer that attaches scripts reports them through it, so the wording is shared.
 */
export class ScriptImportLog {
  private levels = { api: false, folders: 0, requests: 0 };
  private readonly seen = new Set<RequestScripts>();
  private readonly unsupported = new Map<string, Set<string>>();
  private readonly steering = new Map<string, readonly string[]>();

  constructor(private readonly api: LayeredApi) {}

  /** True when at least one level got a script. */
  get any(): boolean {
    return this.levels.api || this.levels.folders > 0 || this.levels.requests > 0;
  }

  /** Records one level's scripts (if it has any) and scans them; returns them unchanged. */
  note(scripts: RequestScripts | undefined, level: ScriptLevel, path: string): RequestScripts | undefined {
    if (scripts === undefined) return undefined;
    // One script set reached through two trees (a folder of REST and gRPC items) counts once.
    if (this.seen.has(scripts)) return scripts;
    this.seen.add(scripts);
    if (level === 'api') this.levels = { ...this.levels, api: true };
    else if (level === 'folder') this.levels = { ...this.levels, folders: this.levels.folders + 1 };
    else this.levels = { ...this.levels, requests: this.levels.requests + 1 };
    const text = [scripts.pre?.text ?? '', scripts.post?.text ?? ''].join('\n');
    const calls = unsupportedCalls(text, this.api);
    if (calls.length > 0) this.unsupported.set(path, new Set(calls));
    const steers = runControlCalls(text, this.api);
    if (steers.length > 0) this.steering.set(path, steers);
    return scripts;
  }

  warnings(): string[] {
    const out: string[] = [];
    const { api, folders, requests } = this.levels;
    const places = [
      ...(api ? ['the API'] : []),
      ...(folders > 0 ? [`${String(folders)} ${folders === 1 ? 'folder' : 'folders'}`] : []),
      ...(requests > 0 ? [`${String(requests)} ${requests === 1 ? 'request' : 'requests'}`] : []),
    ];
    if (places.length > 0) {
      const listed =
        places.length === 1 ? places[0]! : `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]!}`;
      out.push(`Scripts on ${listed} were imported switched off: read each on its Scripts tab, then switch them on`);
    }
    for (const [path, calls] of this.unsupported) {
      // A request a script sends is the one call people most often need, so its warning says what to do instead.
      const sends = ['pm.sendRequest', 'insomnia.sendRequest', 'bru.sendRequest'].find((name) => calls.delete(name));
      if (sends !== undefined) {
        out.push(
          `The scripts of "${path}" call ${sends}, which a script cannot do: send that request as a sequence step, or use OAuth2 auth for a token`,
        );
      }
      if (calls.size > 0) {
        out.push(`The scripts of "${path}" call what Wirebench does not run: ${[...calls].sort().join(', ')}`);
      }
    }
    for (const [path, calls] of this.steering) {
      out.push(`The scripts of "${path}" steer the run (${calls.join(', ')}): obeyed in API and folder runs only`);
    }
    return out;
  }
}
