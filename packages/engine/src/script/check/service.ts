/**
 * The TypeScript language service behind script checking and editing (spec §Type-checking).
 *
 * Each script model gets a service of its own over two virtual files: the declarations (the API and
 * the request's generated types) and the script. Services cannot share a program, because each
 * model's declarations are ambient globals that would clash; they share a document registry, so the
 * standard library is parsed once. Models are kept most-recently-used first, and the oldest is
 * dropped past {@link MAX_MODELS}.
 *
 * Options: `strict`, no emit, ES2023 with no DOM, no `@types`, and `erasableSyntaxOnly`, so that
 * whatever passes the check can be stripped (`../strip.ts`) and run as it is.
 */
import { dirname } from 'node:path';
import ts from 'typescript';
import type { ScriptApi } from '../model.js';

/** Most script models kept at once. */
export const MAX_MODELS = 32;

/** The file names each model's two files have. */
const DECLARATIONS = '/wb/types.d.ts';
const SCRIPT_TS = '/wb/script.ts';
const SCRIPT_JS = '/wb/script.js';

export interface ScriptDiagnostic {
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly message: string;
  readonly code: number;
  readonly severity: 'error' | 'warning';
}

export interface ScriptCompletion {
  readonly name: string;
  readonly kind: string;
  readonly detail?: string;
}

export interface ScriptQuickInfo {
  readonly text: string;
  readonly documentation?: string;
}

export interface ScriptSignatureHelp {
  readonly label: string;
  readonly parameters: readonly string[];
  readonly activeParameter: number;
  readonly documentation?: string;
}

/** What a model holds: the script and the declarations it is checked against. */
export interface ScriptModel {
  readonly source: string;
  readonly declarations: string;
  readonly api: ScriptApi;
}

export const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts'],
  types: [],
  erasableSyntaxOnly: true,
  allowJs: true,
  checkJs: false,
  noLib: false,
  skipLibCheck: true,
};

const registry = ts.createDocumentRegistry();

interface Entry {
  model: ScriptModel;
  version: number;
  readonly service: ts.LanguageService;
}

const models = new Map<string, Entry>();

function scriptFile(model: ScriptModel): string {
  return model.api === 'postman' ? SCRIPT_JS : SCRIPT_TS;
}

function createService(entry: () => Entry): ts.LanguageService {
  const libDir = dirname(ts.getDefaultLibFilePath(COMPILER_OPTIONS));
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => COMPILER_OPTIONS,
    getScriptFileNames: () => [DECLARATIONS, scriptFile(entry().model)],
    getScriptVersion: () => String(entry().version),
    getScriptSnapshot: (name) => {
      const { model } = entry();
      if (name === DECLARATIONS) return ts.ScriptSnapshot.fromString(model.declarations);
      if (name === SCRIPT_TS || name === SCRIPT_JS) return ts.ScriptSnapshot.fromString(model.source);
      const text = ts.sys.readFile(name);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => '/wb',
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    // Only the virtual files and the standard library exist; nothing else on disk is read.
    fileExists: (name) => name === DECLARATIONS || name === SCRIPT_TS || name === SCRIPT_JS || name.startsWith(libDir),
    readFile: (name) => (name.startsWith(libDir) ? ts.sys.readFile(name) : undefined),
    readDirectory: () => [],
    directoryExists: (name) => name === '/wb' || name.startsWith(libDir),
    getDirectories: () => [],
  };
  return ts.createLanguageService(host, registry);
}

/** Sets a model's text, creating its service if it is new. */
export function updateModel(id: string, model: ScriptModel): void {
  const existing = models.get(id);
  if (existing !== undefined) {
    models.delete(id);
    const same =
      existing.model.source === model.source &&
      existing.model.declarations === model.declarations &&
      existing.model.api === model.api;
    if (!same) {
      existing.model = model;
      existing.version += 1;
    }
    models.set(id, existing);
    return;
  }
  const entry: Entry = { model, version: 1, service: undefined as unknown as ts.LanguageService };
  (entry as { service: ts.LanguageService }).service = createService(() => entry);
  models.set(id, entry);
  while (models.size > MAX_MODELS) {
    const oldest = models.keys().next().value;
    if (oldest === undefined) break;
    models.get(oldest)?.service.dispose();
    models.delete(oldest);
  }
}

export function removeModel(id: string): void {
  models.get(id)?.service.dispose();
  models.delete(id);
}

function entryOf(id: string): Entry {
  const entry = models.get(id);
  if (entry === undefined) throw new Error(`No script model "${id}"`);
  return entry;
}

function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, column: offset - lastBreak };
}

function offsetOf(source: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = source.indexOf('\n', offset);
    if (next === -1) return source.length;
    offset = next + 1;
  }
  return Math.min(source.length, offset + column - 1);
}

/**
 * The script's diagnostics. A Postman script (JavaScript) gets only its syntax errors; a typed one
 * gets syntax and type errors. Errors in the declarations themselves are not the script's and are
 * left out.
 */
export function diagnosticsOf(id: string): ScriptDiagnostic[] {
  const { model, service } = entryOf(id);
  const file = scriptFile(model);
  const found = [
    ...service.getSyntacticDiagnostics(file),
    ...(model.api === 'postman' ? [] : service.getSemanticDiagnostics(file)),
  ];
  return found.map((d) => {
    const start = d.start ?? 0;
    const from = lineColumn(model.source, start);
    const to = lineColumn(model.source, start + (d.length ?? 0));
    return {
      line: from.line,
      column: from.column,
      endLine: to.line,
      endColumn: to.column,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      code: d.code,
      severity: d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
    };
  });
}

/** Completions at a 1-based position, at most 200. */
export function completionsAt(id: string, line: number, column: number): ScriptCompletion[] {
  const { model, service } = entryOf(id);
  const info = service.getCompletionsAtPosition(scriptFile(model), offsetOf(model.source, line, column), {
    includeCompletionsWithInsertText: true,
  });
  return (info?.entries ?? [])
    .filter((entry) => !entry.name.startsWith('__') && !entry.name.startsWith('Wb'))
    .slice(0, 200)
    .map((entry) => ({ name: entry.name, kind: entry.kind }));
}

export function quickInfoAt(id: string, line: number, column: number): ScriptQuickInfo | undefined {
  const { model, service } = entryOf(id);
  const info = service.getQuickInfoAtPosition(scriptFile(model), offsetOf(model.source, line, column));
  if (info === undefined) return undefined;
  const documentation = ts.displayPartsToString(info.documentation);
  return {
    text: ts.displayPartsToString(info.displayParts),
    ...(documentation !== '' ? { documentation } : {}),
  };
}

export function signatureHelpAt(id: string, line: number, column: number): ScriptSignatureHelp | undefined {
  const { model, service } = entryOf(id);
  const help = service.getSignatureHelpItems(scriptFile(model), offsetOf(model.source, line, column), undefined);
  const item = help?.items[help.selectedItemIndex];
  if (help === undefined || item === undefined) return undefined;
  const parameters = item.parameters.map((p) => ts.displayPartsToString(p.displayParts));
  const documentation = ts.displayPartsToString(item.documentation);
  return {
    label: `${ts.displayPartsToString(item.prefixDisplayParts)}${parameters.join(ts.displayPartsToString(item.separatorDisplayParts))}${ts.displayPartsToString(item.suffixDisplayParts)}`,
    parameters,
    activeParameter: help.argumentIndex,
    ...(documentation !== '' ? { documentation } : {}),
  };
}

/** One-shot check of a script against declarations, without keeping a model. */
export function checkOnce(model: ScriptModel): ScriptDiagnostic[] {
  const id = `once:${String(Math.random())}`;
  updateModel(id, model);
  try {
    return diagnosticsOf(id);
  } finally {
    removeModel(id);
  }
}
