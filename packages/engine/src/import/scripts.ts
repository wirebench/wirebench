/**
 * Scripts an importer keeps as text (spec §7.4, §6.2): written under `imported-scripts/` by the
 * desktop main process, never read back or run. The path rule here is pure.
 */
import { slugify } from '../project/paths.js';
import { UNSUPPORTED_DEFAULT_REASON, UNSUPPORTED_WHY } from '../script/api/layer-parts.js';
import { TOP_LEVEL_IMPORT, TOP_LEVEL_IMPORT_REASON } from '../script/module-syntax.js';
import type { LayeredApi, RequestScripts } from '../script/model.js';
import type { ReportBuilder } from './report.js';

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

/**
 * A level's scripts as v2.1 `event` entries, for a converter that writes the collection document the
 * shared mapper reads: `prerequest` first, then `test` (the after-response script). A blank script
 * is skipped, and a level with none has no `event` at all.
 */
export function eventsOf(scripts: {
  readonly pre?: string;
  readonly post?: string;
}): { event: Record<string, unknown>[] } | Record<string, never> {
  const event: Record<string, unknown>[] = [];
  if (scripts.pre !== undefined && scripts.pre.trim() !== '')
    event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: scripts.pre } });
  if (scripts.post !== undefined && scripts.post.trim() !== '')
    event.push({ listen: 'test', script: { type: 'text/javascript', exec: scripts.post } });
  return event.length > 0 ? { event } : {};
}

/** One level of a dropped API that held scripts: its names from the API down and its two scripts. */
export interface DroppedLevel {
  readonly path: readonly string[];
  readonly pre?: string;
  readonly post?: string;
}

/**
 * The text files for the scripts of an API dropped because it holds no HTTP request: no tree is
 * left to attach them to, so each is saved as `imported-scripts/<api>/<owner>.<phase>.js`, as the
 * OpenCollection importer saves its loose scripts, and the report names the file. A blank script
 * is skipped. `taken` is the set of paths this import already wrote and is shared by every call of
 * one import, so two dropped APIs whose names slugify alike (`Idle`, `idle`) never write one path.
 */
export function droppedApiScriptFiles(
  apiSlug: string,
  levels: readonly DroppedLevel[],
  report: ReportBuilder,
  taken: Set<string>,
): ImportedScriptFile[] {
  const files: ImportedScriptFile[] = [];
  for (const { path: names, pre, post } of levels) {
    const owner = names.join(' / ');
    for (const [phase, source] of [
      ['pre', pre],
      ['post', post],
    ] as const) {
      if (source === undefined || source.trim() === '') continue;
      const path = importedScriptPath(apiSlug, slugify(names.join('-')).toLowerCase(), `${phase}.js`, taken);
      report.note(
        `${owner}: its ${phase} script has no place to run in Wirebench, so it was saved to ${path} and is never run.`,
      );
      files.push({ path, source });
    }
  }
  return files;
}

/** A level's scripts of one kind, in the order the client runs them; two of one kind are joined. */
export function scriptText(texts: readonly string[]): string {
  return texts.map((text) => `${text.trimEnd()}\n`).join('\n');
}

/** Why Hoppscotch's layer refuses the `pm` members Hoppscotch's own `pm` does not have. */
const NOT_IN_CLIENT = 'the pm object of these scripts does not have it';
const WHY = UNSUPPORTED_WHY;

/**
 * The calls a script makes that its API's layer does not run (spec §Postman), found by name. Each
 * other client's list is filled by its layer. The third item is the reason the layer gives when the
 * call runs, which the converter's TODO repeats; a test holds each one to its layer's source.
 * `undefined` marks a call this list still names although the layer now runs it (Postman's
 * `pm.iterationData`, since data-driven runs).
 */
export const UNSUPPORTED_CALLS: Readonly<
  Record<LayeredApi, readonly (readonly [RegExp, string, string | undefined])[]>
> = {
  postman: [
    [/\bpm\.sendRequest\b/, 'pm.sendRequest', WHY.send],
    [/\bpm\.cookies\.jar\b/, 'pm.cookies.jar', WHY.cookies],
    [/\bpm\.visualizer\b/, 'pm.visualizer', WHY.visual],
    [/\brequire\s*\(/, 'require', WHY.modules],
    [/\bpm\.iterationData\b/, 'pm.iterationData', undefined],
    [/\bpm\.vault\b/, 'pm.vault', WHY.vault],
  ],
  insomnia: [
    [/(?<![\w$.])(?:insomnia|\$)\.sendRequest\b/, 'insomnia.sendRequest', WHY.send],
    [/(?<![\w$.])(?:insomnia|\$)\.require\b/, 'insomnia.require', WHY.modules],
    [/(?<![\w$.])require\s*\(/, 'require', WHY.modules],
    [/(?<![\w$.])(?:insomnia|\$)\.cookies\.(?:set|unset|clear)\b/, 'insomnia.cookies writes', WHY.cookies],
    [/(?<![\w$.])(?:insomnia|\$)\.vault\b/, 'insomnia.vault', WHY.vault],
  ],
  bruno: [
    [/(?<![\w$.])bru\.sendRequest\b/, 'bru.sendRequest', WHY.send],
    [/(?<![\w$.])bru\.runRequest\b/, 'bru.runRequest', WHY.send],
    [/(?<![\w$.])bru\.getProcessEnv\b/, 'bru.getProcessEnv', WHY.processEnv],
    [/(?<![\w$.])bru\.visualize\b/, 'bru.visualize', WHY.visual],
    [/(?<![\w$.])bru\.deleteAllVars\b/, 'bru.deleteAllVars', WHY.values],
    [/(?<![\w$.])req\.getAuthMode\b/, 'req.getAuthMode', WHY.auth],
    [/(?<![\w$.])req\.setHeaders\b/, 'req.setHeaders', UNSUPPORTED_DEFAULT_REASON],
    [/(?<![\w$.])res\.setBody\b/, 'res.setBody', WHY.response],
    [/(?<![\w$.])res\.setHeader\b/, 'res.setHeader', WHY.response],
    [/(?<![\w$.])bru\.sleep\b/, 'bru.sleep', WHY.wait],
    [/(?<![\w$.])bru\.cookies\b/, 'bru.cookies', WHY.cookies],
    [/(?<![\w$.])req\.setTimeout\b/, 'req.setTimeout', WHY.settings],
    [/(?<![\w$.])req\.getTimeout\b/, 'req.getTimeout', WHY.settings],
    [/(?<![\w$.])req\.setMaxRedirects\b/, 'req.setMaxRedirects', WHY.settings],
    [/(?<![\w$.])req\.onFail\b/, 'req.onFail', WHY.handling],
    [/(?<![\w$.])req\.disableParsingResponseJson\b/, 'req.disableParsingResponseJson', WHY.handling],
    [/(?<![\w$.])require\s*\(/, 'require', WHY.modules],
  ],
  hoppscotch: [
    [/(?<![\w$.])hopp\.cookies\b/, 'hopp.cookies', WHY.cookies],
    [/(?<![\w$.])hopp\.fetch\b/, 'hopp.fetch', WHY.send],
    [/(?<![\w$.])pm\.sendRequest\b/, 'pm.sendRequest', WHY.send],
    [/(?<![\w$.])pm\.collectionVariables\b/, 'pm.collectionVariables', NOT_IN_CLIENT],
    [/(?<![\w$.])pm\.iterationData\b/, 'pm.iterationData', NOT_IN_CLIENT],
    [/(?<![\w$.])pm\.visualizer\b/, 'pm.visualizer', WHY.visual],
    [/(?<![\w$.])pm\.execution\.setNextRequest\b/, 'pm.execution.setNextRequest', NOT_IN_CLIENT],
    [/(?<![\w$.])pm\.execution\.skipRequest\b/, 'pm.execution.skipRequest', NOT_IN_CLIENT],
    [/(?<![\w$.])pm\.vault\b/, 'pm.vault', WHY.vault],
    [/(?<![\w$.])pm\.cookies\.jar\b/, 'pm.cookies.jar', WHY.cookies],
    [/(?<![\w$.])pm\.require\b/, 'pm.require', WHY.modules],
    [/(?<![\w$.])hopp\.env(?:\.(?:active|global))?\.reset\b/, 'hopp.env.reset', WHY.initial],
    [/(?<![\w$.])hopp\.env(?:\.(?:active|global))?\.getInitialRaw\b/, 'hopp.env.getInitialRaw', WHY.initial],
    [/(?<![\w$.])hopp\.env(?:\.(?:active|global))?\.setInitial\b/, 'hopp.env.setInitial', WHY.initial],
    [/(?<![\w$.])hopp\.request\.setAuth\b/, 'hopp.request.setAuth', WHY.auth],
    [/(?<![\w$.])hopp\.request\.auth\b/, 'hopp.request.auth', WHY.auth],
    [/(?<![\w$.])hopp\.response\.body\.bytes\b/, 'hopp.response.body.bytes', WHY.binary],
    [/(?<![\w$.])require\s*\(/, 'require', WHY.modules],
    [TOP_LEVEL_IMPORT, 'import', TOP_LEVEL_IMPORT_REASON],
  ],
  'thunder-client': [
    [/(?<![\w$.])tc\.runRequest\b/, 'tc.runRequest', WHY.send],
    [/(?<![\w$.])tc\.retryRequest\b/, 'tc.retryRequest', WHY.send],
    [/(?<![\w$.])tc\.loadModule\b/, 'tc.loadModule', WHY.modules],
    [/(?<![\w$.])tc\.loadFromPath\b/, 'tc.loadFromPath', WHY.files],
    [/(?<![\w$.])tc\.readFile\b/, 'tc.readFile', WHY.files],
    [/(?<![\w$.])tc\.exec\b/, 'tc.exec', WHY.programs],
    [/(?<![\w$.])tc\.delay\b/, 'tc.delay', WHY.wait],
    [
      /(?<![\w$.])tc\.skipRequest\s*\(\s*[^\s)]/,
      'tc.skipRequest with a request name',
      'a script can skip only its own request',
    ],
    [/(?<![\w$.])tc\.getAbsolutePath\b/, 'tc.getAbsolutePath', WHY.files],
    [/(?<![\w$.])tc\.getCookies\b/, 'tc.getCookies', WHY.cookies],
    [/(?<![\w$.])tc\.setCookie\b/, 'tc.setCookie', WHY.cookies],
    [/(?<![\w$.])tc\.clearCookies\b/, 'tc.clearCookies', WHY.cookies],
    [/(?<![\w$.])tc\.chartHTML\b/, 'tc.chartHTML', WHY.visual],
    [/(?<![\w$.])tc\.response\.cookies\b/, 'tc.response.cookies', WHY.cookies],
    [/(?<![\w$.])tc\.response\.getBinary\b/, 'tc.response.getBinary', WHY.binary],
    [/(?<![\w$.])tc\.response\.passed\b/, 'tc.response.passed', UNSUPPORTED_DEFAULT_REASON],
    [/(?<![\w$.])tc\.request\.auth\b/, 'tc.request.auth', WHY.auth],
    [/(?<![\w$.])tc\.request\.url\.getParam\b/, 'tc.request.url.getParam', UNSUPPORTED_DEFAULT_REASON],
    [/(?<![\w$.])tc\.request\.url\.setParam\b/, 'tc.request.url.setParam', UNSUPPORTED_DEFAULT_REASON],
    [/(?<![\w$.])assert\s*[.(]/, 'assert', 'use expect'],
    [/(?<![\w$.])require\s*\(\s*['"`]thunder-tests\//, 'require("thunder-tests/...")', WHY.modules],
    [/(?<![\w$.])require\s*\((?!\s*['"`]thunder-tests\/)/, 'require', WHY.modules],
  ],
};

export function unsupportedCalls(text: string, api: LayeredApi): string[] {
  return UNSUPPORTED_CALLS[api].filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}

/**
 * The refused call `form` is, with the layer's reason, or undefined. `form` is one call written out
 * alone (`pm.sendRequest(x)`, `require('thunder-tests/a.js')`), so a call named in its arguments is
 * not taken for it.
 */
export function unsupportedCall(form: string, api: LayeredApi): { name: string; reason: string } | undefined {
  for (const [pattern, name, reason] of UNSUPPORTED_CALLS[api]) {
    if (reason !== undefined && pattern.test(form)) return { name, reason };
  }
  return undefined;
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
  'thunder-client': [[/(?<![\w$.])tc\.skipRequest\s*\(\s*\)/, 'tc.skipRequest']],
};

export function runControlCalls(text: string, api: LayeredApi = 'postman'): string[] {
  return (RUN_CONTROL_CALLS[api] ?? []).filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}

/** The calls that send another request, whose warning says what to do instead. */
const SEND_CALLS = [
  'pm.sendRequest',
  'insomnia.sendRequest',
  'bru.sendRequest',
  'bru.runRequest',
  'hopp.fetch',
  'tc.runRequest',
  'tc.retryRequest',
];

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
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
      out.push(
        `Scripts on ${listed(places)} were imported switched off: read each on its Scripts tab, then switch them on.`,
      );
    }
    for (const [path, calls] of this.unsupported) {
      // A request a script sends is the one call people most often need, so its warning says what to do instead.
      const sends = SEND_CALLS.filter((name) => calls.delete(name)).sort();
      if (sends.length > 0) {
        out.push(
          `The scripts of "${path}" call ${listed(sends)}, which a script cannot do: send that request as a sequence step, or use OAuth2 auth for a token`,
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
