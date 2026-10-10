/**
 * The script editor's language features (#63), run as Monaco would run them: each provider asks
 * main only about a model a script editor registered, maps the checker's answer into Monaco's
 * shapes, and a diagnostics answer for text the model no longer holds is dropped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeMonaco,
  fakeMonacoWithMarkers,
  registeredCompletionProviders,
  registeredHoverProviders,
  registeredSignatureHelpProviders,
  setMarkers,
} from '../mocks/monaco-editor-react.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import {
  completionKindOf,
  dispatchScriptModelPath,
  refreshScriptDiagnostics,
  registerScriptLanguageOnce,
  scriptModelPath,
  setScriptModelTarget,
  toMarker,
} from '../../src/renderer/editor/script-language.js';

const completions = vi.fn();
const quickInfo = vi.fn();
const signatureHelp = vi.fn();
const diagnostics = vi.fn();

registerScriptLanguageOnce(fakeMonaco as never);
registerScriptLanguageOnce(fakeMonaco as never);

type Provider<K extends string> = Record<K, (model: unknown, position: unknown) => Promise<unknown>>;
const completion = registeredCompletionProviders.find((entry) => entry.language === 'typescript')
  ?.provider as Provider<'provideCompletionItems'>;
const hover = registeredHoverProviders.find((entry) => entry.language === 'typescript')
  ?.provider as Provider<'provideHover'>;
const signature = registeredSignatureHelpProviders.find((entry) => entry.language === 'typescript')
  ?.provider as Provider<'provideSignatureHelp'>;

function model(uri: string, text: string, version = 1) {
  return {
    uri: { toString: () => uri },
    getValue: () => text,
    getVersionId: () => version,
    isDisposed: () => false,
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 3 }),
  };
}

const POSITION = { lineNumber: 1, column: 3 };

beforeEach(() => {
  completions.mockReset();
  quickInfo.mockReset();
  signatureHelp.mockReset();
  diagnostics.mockReset();
  installWirebenchApi({ script: { completions, quickInfo, signatureHelp, diagnostics } });
  setMarkers.length = 0;
  setScriptModelTarget('file:///script', { requestId: 'r1', phase: 'pre' });
});

describe('registration', () => {
  it('registers each provider once, for TypeScript and JavaScript', () => {
    expect(registeredCompletionProviders.map((entry) => entry.language)).toEqual(['typescript', 'javascript']);
    expect(registeredHoverProviders.map((entry) => entry.language)).toEqual(['typescript', 'javascript']);
    expect(registeredSignatureHelpProviders.map((entry) => entry.language)).toEqual(['typescript', 'javascript']);
  });

  it('names a model after its script file', () => {
    expect(scriptModelPath('a b', 'post', 'wirebench')).toBe('wirebench-script/a%20b/post.ts');
    expect(scriptModelPath('r1', 'pre', 'postman')).toBe('wirebench-script/r1/pre.js');
    expect(dispatchScriptModelPath('m 1', 'o1')).toBe('wirebench-script/m%201/o1/dispatch.ts');
  });
});

describe('completion', () => {
  it("asks main about a mock operation's dispatch script by mock and operation (#352)", async () => {
    completions.mockResolvedValue({ ok: true, value: { items: [{ name: 'respond', kind: 'function' }] } });
    setScriptModelTarget('file:///dispatch', { mockId: 'm1', operationId: 'o1' });

    await completion.provideCompletionItems(model('file:///dispatch', 're'), POSITION);

    expect(completions).toHaveBeenCalledWith({ mockId: 'm1', operationId: 'o1', source: 're', line: 1, column: 3 });
  });

  it("asks main about a script's model, and maps each item's kind", async () => {
    completions.mockResolvedValue({
      ok: true,
      value: {
        items: [
          { name: 'vars', kind: 'const', detail: 'const vars' },
          { name: 'log', kind: 'function' },
        ],
      },
    });

    const result = (await completion.provideCompletionItems(model('file:///script', 'va'), POSITION)) as {
      suggestions: { label: string; kind: number; range: unknown; detail?: string }[];
    };

    expect(completions).toHaveBeenCalledWith({ requestId: 'r1', phase: 'pre', source: 'va', line: 1, column: 3 });
    expect(result.suggestions.map((item) => [item.label, item.kind, item.detail])).toEqual([
      ['vars', fakeMonaco.languages.CompletionItemKind.Constant, 'const vars'],
      ['log', fakeMonaco.languages.CompletionItemKind.Function, undefined],
    ]);
    expect(result.suggestions[0]?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 3,
    });
  });

  it('asks nothing about a model no script editor registered', async () => {
    const result = (await completion.provideCompletionItems(model('file:///other', 'va'), POSITION)) as {
      suggestions: unknown[];
    };
    expect(result.suggestions).toEqual([]);
    expect(completions).not.toHaveBeenCalled();
  });

  it('maps an unknown kind to text', () => {
    expect(completionKindOf(fakeMonaco.languages.CompletionItemKind as never, 'something-new')).toBe(
      fakeMonaco.languages.CompletionItemKind.Text,
    );
  });
});

describe('hover and signature help', () => {
  it('shows the type as TypeScript, then its documentation', async () => {
    quickInfo.mockResolvedValue({
      ok: true,
      value: { info: { text: 'const vars: WbVars', documentation: 'Values.' } },
    });
    const result = (await hover.provideHover(model('file:///script', 'vars'), POSITION)) as {
      contents: { value: string }[];
    };
    expect(result.contents.map((part) => part.value)).toEqual(['```typescript\nconst vars: WbVars\n```', 'Values.']);
  });

  it('answers null when main has nothing to say', async () => {
    quickInfo.mockResolvedValue({ ok: true, value: {} });
    expect(await hover.provideHover(model('file:///script', ''), POSITION)).toBeNull();
    signatureHelp.mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } });
    expect(await signature.provideSignatureHelp(model('file:///script', ''), POSITION)).toBeNull();
  });

  it('shows the signature with its active parameter', async () => {
    signatureHelp.mockResolvedValue({
      ok: true,
      value: {
        help: {
          label: 'set(name: string, value: string): void',
          parameters: ['name: string', 'value: string'],
          activeParameter: 1,
        },
      },
    });
    const result = (await signature.provideSignatureHelp(model('file:///script', 'vars.set("a", '), POSITION)) as {
      value: { signatures: { label: string; parameters: { label: string }[] }[]; activeParameter: number };
    };
    expect(result.value.signatures[0]?.parameters.map((parameter) => parameter.label)).toEqual([
      'name: string',
      'value: string',
    ]);
    expect(result.value.activeParameter).toBe(1);
  });
});

describe('diagnostics', () => {
  const error = {
    line: 2,
    column: 3,
    endLine: 2,
    endColumn: 3,
    message: 'Cannot find name',
    code: 2304,
    severity: 'error' as const,
  };

  it('turns an empty range into a one-character marker', () => {
    expect(toMarker(fakeMonaco.MarkerSeverity as never, error)).toMatchObject({
      startLineNumber: 2,
      startColumn: 3,
      endColumn: 4,
      severity: fakeMonaco.MarkerSeverity.Error,
    });
  });

  it('sets the markers for the text it was asked about', async () => {
    diagnostics.mockResolvedValue({ ok: true, value: { diagnostics: [error] } });
    const found = await refreshScriptDiagnostics(fakeMonacoWithMarkers as never, model('file:///script', 'x') as never);
    expect(found).toEqual([error]);
    expect(setMarkers).toEqual([{ uri: 'file:///script', owner: 'wirebench-script', markers: [expect.anything()] }]);
  });

  it('drops an answer for text the model no longer holds', async () => {
    let version = 1;
    const changing = { ...model('file:///script', 'x'), getVersionId: () => version };
    diagnostics.mockImplementation(() => {
      version = 2;
      return Promise.resolve({ ok: true, value: { diagnostics: [error] } });
    });
    expect(await refreshScriptDiagnostics(fakeMonacoWithMarkers as never, changing as never)).toEqual([]);
    expect(setMarkers).toEqual([]);
  });
});
