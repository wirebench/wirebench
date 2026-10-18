/**
 * The mapping table (spec §6): one row per dialect call, with the typed API's text per protocol.
 * A row is data; `match.ts` reads it. A call with no row, or with a row that has no template for the
 * script's protocol or phase, becomes a TODO (spec §5.2).
 *
 * The `pm.*` rows also hold Insomnia's `insomnia.*` and `$.*` and Hoppscotch's `pm.*` (spec §6.2).
 * A row may list a call the dialect's layer refuses (Hoppscotch's `pm.execution`): the converter
 * decides those before it asks the table, so they stay TODOs with the layer's reason (§6.8).
 */
import { SKIP_REQUEST_PRE_ONLY } from '../api/prelude.js';
import type { LayeredApi, ScriptPhase } from '../model.js';
import type { ConvertProtocol } from './roots.js';

/** A template: the converted text of the matched arguments in, the typed API's text out. */
export type Template = (args: readonly string[]) => string;

export interface MappingRow {
  /** The qualified names, as the layer names them: `bru.setVar`, `$.environment.get`. */
  readonly calls: readonly string[];
  readonly dialects: readonly LayeredApi[];
  /** The one phase the row works in; absent: both. */
  readonly phase?: ScriptPhase;
  /**
   * The layer's reason for refusing the call in the other phase. With it the call is an
   * `unsupported` TODO there; without it, "not converted yet".
   */
  readonly otherPhase?: string;
  /**
   * What is matched (default `call`):
   * - `call`: the chain called with `arity` arguments (plus up to `ignored` more); the template
   *   gets the arguments.
   * - `property`: the chain read, neither called nor written; the template gets no arguments.
   * - `object-key-value`: the chain called with one object literal holding `key` and `value` and
   *   nothing else; the template gets `[key, value]`.
   * - `string-literal`: as `call`, and the first argument is a string literal.
   */
  readonly shape?: 'call' | 'property' | 'object-key-value' | 'string-literal';
  /** For `call` and `string-literal`: how many arguments the template takes (default 0). */
  readonly arity?: number;
  /**
   * How many more arguments may follow. They are dropped, so each must be a literal (a scope name,
   * an options object of literals); a call with any other one is left as a TODO.
   */
  readonly ignored?: number;
  /**
   * The template is a comparison or another expression that binds looser than a unary or member
   * operator. It is parenthesised unless its position already separates it (a statement, an
   * argument, an `if` condition, an operand of `&&` or `||`).
   */
  readonly loose?: true;
  readonly to: Partial<Record<ConvertProtocol, Template>>;
}

/** The protocols every row here works on: variables, run control and iteration are protocol-free. */
const PROTOCOLS: readonly ConvertProtocol[] = ['rest', 'soap', 'grpc', 'mcp'];

/** The same template for every protocol. */
const everyProtocol = (template: Template): Record<ConvertProtocol, Template> =>
  Object.fromEntries(PROTOCOLS.map((protocol) => [protocol, template])) as Record<ConvertProtocol, Template>;

/** The dialects whose scripts reach a `pm`-shaped object. */
const PM_DIALECTS: readonly LayeredApi[] = ['postman', 'insomnia', 'hoppscotch'];

/** `chain` under each `pm`-shaped root: `pm`, `insomnia` and `$`. */
const pmShaped = (...chains: readonly string[]): string[] =>
  ['pm', 'insomnia', '$'].flatMap((root) => chains.map((chain) => `${root}.${chain}`));

/** `chain` under Insomnia's roots only. */
const insomniaOnly = (...chains: readonly string[]): string[] =>
  ['insomnia', '$'].flatMap((root) => chains.map((chain) => `${root}.${chain}`));

/** `method` on every variable scope (spec §6.2). */
const scopes = (method: string): string[] => [
  ...pmShaped(...['environment', 'collectionVariables', 'globals', 'variables'].map((s) => `${s}.${method}`)),
  ...insomniaOnly(...['baseEnvironment', 'parentFolders'].map((s) => `${s}.${method}`)),
];

/** Hoppscotch's `hopp.env` and its `active` and `global` scopes. */
const hoppEnv = (method: string): string[] =>
  ['hopp.env', 'hopp.env.active', 'hopp.env.global'].map((s) => `${s}.${method}`);

// Every layer reads `vars` first, then `props` (spec §6.3); the parentheses keep `??` safe anywhere.
const read: Template = ([name]) => `(vars.get(${String(name)}) ?? props.get(${String(name)}))`;
const write: Template = ([name, value]) => `vars.set(${String(name)}, ${String(value)})`;
const has: Template = (args) => `${read(args)} !== undefined`;

/** §6.3 variables and §6.7 run control and iteration. */
export const VARIABLE_AND_RUN_MAPPINGS: readonly MappingRow[] = [
  // --- §6.3 writes
  { calls: scopes('set'), dialects: PM_DIALECTS, arity: 2, to: everyProtocol(write) },
  {
    calls: ['bru.setVar', 'bru.setEnvVar', 'bru.setGlobalEnvVar'],
    dialects: ['bruno'],
    arity: 2,
    // bru.setEnvVar's options ({ persist: true }) change nothing in a run.
    ignored: 1,
    to: everyProtocol(write),
  },
  // The scope argument (local, global, request) picks nothing: every one is a run value.
  { calls: ['tc.setVar'], dialects: ['thunder-client'], arity: 2, ignored: 1, to: everyProtocol(write) },
  { calls: ['pw.env.set', ...hoppEnv('set')], dialects: ['hoppscotch'], arity: 2, to: everyProtocol(write) },
  {
    calls: ['postman.setEnvironmentVariable', 'postman.setGlobalVariable'],
    dialects: ['postman'],
    arity: 2,
    to: everyProtocol(write),
  },
  // --- §6.3 reads
  { calls: scopes('get'), dialects: PM_DIALECTS, arity: 1, to: everyProtocol(read) },
  {
    calls: [
      'bru.getVar',
      'bru.getEnvVar',
      'bru.getGlobalEnvVar',
      'bru.getCollectionVar',
      'bru.getFolderVar',
      'bru.getRequestVar',
    ],
    dialects: ['bruno'],
    arity: 1,
    to: everyProtocol(read),
  },
  { calls: ['tc.getVar'], dialects: ['thunder-client'], arity: 1, to: everyProtocol(read) },
  { calls: ['pw.env.get'], dialects: ['hoppscotch'], arity: 1, to: everyProtocol(read) },
  {
    calls: ['postman.getEnvironmentVariable', 'postman.getGlobalVariable'],
    dialects: ['postman'],
    arity: 1,
    to: everyProtocol(read),
  },
  {
    calls: hoppEnv('getRaw'),
    dialects: ['hoppscotch'],
    arity: 1,
    to: everyProtocol(([name]) => `(vars.get(${String(name)}) ?? props.get(${String(name)}) ?? null)`),
  },
  // --- §6.3 has
  { calls: scopes('has'), dialects: PM_DIALECTS, arity: 1, loose: true, to: everyProtocol(has) },
  { calls: ['bru.hasVar'], dialects: ['bruno'], arity: 1, loose: true, to: everyProtocol(has) },
  // --- §6.7 run control
  {
    calls: [...pmShaped('execution.setNextRequest'), 'postman.setNextRequest'],
    dialects: PM_DIALECTS,
    arity: 1,
    to: everyProtocol(([name]) => `execution.setNextRequest(${String(name)})`),
  },
  {
    calls: ['bru.setNextRequest'],
    dialects: ['bruno'],
    arity: 1,
    to: everyProtocol(([name]) => `execution.setNextRequest(${String(name)})`),
  },
  {
    calls: pmShaped('execution.skipRequest'),
    dialects: PM_DIALECTS,
    phase: 'pre',
    otherPhase: SKIP_REQUEST_PRE_ONLY,
    to: everyProtocol(() => 'execution.skipRequest()'),
  },
  {
    calls: ['bru.runner.skipRequest'],
    dialects: ['bruno'],
    phase: 'pre',
    otherPhase: SKIP_REQUEST_PRE_ONLY,
    to: everyProtocol(() => 'execution.skipRequest()'),
  },
  // With an argument it names another request; the layer refuses that before the table is asked.
  {
    calls: ['tc.skipRequest'],
    dialects: ['thunder-client'],
    phase: 'pre',
    otherPhase: SKIP_REQUEST_PRE_ONLY,
    to: everyProtocol(() => 'execution.skipRequest()'),
  },
  {
    calls: ['bru.runner.stopExecution'],
    dialects: ['bruno'],
    to: everyProtocol(() => 'execution.setNextRequest(null)'),
  },
  // --- §6.7 iteration
  {
    calls: pmShaped('info.iteration'),
    dialects: PM_DIALECTS,
    shape: 'property',
    to: everyProtocol(() => 'iteration.index'),
  },
  {
    calls: ['tc.info.currentIteration'],
    dialects: ['thunder-client'],
    shape: 'property',
    to: everyProtocol(() => 'iteration.index'),
  },
  {
    calls: pmShaped('info.iterationCount'),
    dialects: PM_DIALECTS,
    shape: 'property',
    to: everyProtocol(() => 'iteration.count'),
  },
  {
    calls: ['tc.info.totalIterations'],
    dialects: ['thunder-client'],
    shape: 'property',
    to: everyProtocol(() => 'iteration.count'),
  },
  {
    calls: pmShaped('iterationData.get'),
    dialects: PM_DIALECTS,
    arity: 1,
    to: everyProtocol(([column]) => `iteration.data.get(${String(column)})`),
  },
];

/** The whole table. Later sections add their rows here. */
export const MAPPINGS: readonly MappingRow[] = [...VARIABLE_AND_RUN_MAPPINGS];
