/**
 * The Monaco side of variables in the editor (#340), against a stand-in Monaco: which models get
 * help, what completion and hover answer there, the unresolved marks, and Set as Variable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/features/environments/variable-edit-target.js', () => ({
  openVariableEditTarget: vi.fn(),
}));

import { openVariableEditTarget } from '../../src/renderer/features/environments/variable-edit-target.js';
import {
  attachVariableAssist,
  EDIT_VARIABLE_COMMAND,
  hoverMarkdown,
  VARIABLE_MARKER_OWNER,
} from '../../src/renderer/editor/variable-assist-monaco.js';
import type { RequestVariables } from '../../src/renderer/editor/variable-assist.js';

const variables: RequestVariables = {
  entries: [
    {
      name: 'host',
      scope: 'Env',
      value: 'dev.example',
      masked: false,
      shadowed: false,
      edit: { kind: 'environment', id: 'e1' },
    },
    { name: 'apiKey', scope: 'Project', masked: true, secretName: 'api_key', shadowed: false },
  ],
  secretNames: [],
};

interface Position {
  readonly lineNumber: number;
  readonly column: number;
}

let nextUri = 1;

/** A text model over `text`, with Monaco's 1-based positions. */
function model(text: string) {
  const uri = `inmemory://model/v${String(nextUri++)}`;
  const lines = text.split('\n');
  const getPositionAt = (offset: number): Position => {
    let rest = offset;
    for (let index = 0; index < lines.length; index += 1) {
      const length = lines[index]!.length;
      if (rest <= length) return { lineNumber: index + 1, column: rest + 1 };
      rest -= length + 1;
    }
    return { lineNumber: lines.length, column: lines.at(-1)!.length + 1 };
  };
  const getOffsetAt = (position: Position): number =>
    lines.slice(0, position.lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + position.column - 1;
  return {
    uri: { toString: () => uri },
    getValue: () => text,
    getLineContent: (line: number) => lines[line - 1]!,
    getPositionAt,
    getOffsetAt,
    isDisposed: () => false,
    getValueInRange: (range: { start: number; end: number }) => text.slice(range.start, range.end),
  };
}

type Provider = Record<string, (...args: unknown[]) => unknown>;

function fakeMonaco() {
  const completion = new Map<string, Provider>();
  const hover = new Map<string, Provider>();
  const commands = new Map<string, (...args: unknown[]) => void>();
  const markers: { uri: string; owner: string; markers: unknown[] }[] = [];
  const monacoNS = {
    languages: {
      CompletionItemKind: { Variable: 4 },
      registerCompletionItemProvider: (language: string, provider: Provider) => completion.set(language, provider),
      registerHoverProvider: (language: string, provider: Provider) => hover.set(language, provider),
    },
    editor: {
      registerCommand: (id: string, handler: (...args: unknown[]) => void) => commands.set(id, handler),
      setModelMarkers: (target: ReturnType<typeof model>, owner: string, list: unknown[]) =>
        markers.push({ uri: target.uri.toString(), owner, markers: list }),
    },
  };
  return { monacoNS, completion, hover, commands, markers };
}

function fakeEditor(target: ReturnType<typeof model>, selection?: { start: number; end: number }) {
  const actions: { id: string; run: (editor: unknown) => void }[] = [];
  const edits: unknown[] = [];
  let onChange: () => void = () => undefined;
  const editor = {
    getModel: () => target,
    onDidChangeModelContent: (listener: () => void) => {
      onChange = listener;
      return { dispose: () => undefined };
    },
    addAction: (action: { id: string; run: (editor: unknown) => void }) => {
      actions.push(action);
      return { dispose: () => undefined };
    },
    getSelection: () => selection ?? null,
    executeEdits: (_source: string, list: unknown[]) => edits.push(...list),
  };
  return { editor, actions, edits, change: () => onChange() };
}

// One stand-in Monaco for the whole file: registration is once per process.
const fake = fakeMonaco();

describe('attachVariableAssist', () => {
  beforeEach(() => {
    fake.markers.length = 0;
  });

  it('marks unresolved references at once, and clears them on dispose', () => {
    const text = model('{"url": "${host}/${hots}"}');
    const { editor } = fakeEditor(text);
    const handle = attachVariableAssist(editor as never, fake.monacoNS as never, { variables: () => variables });
    expect(fake.markers.at(-1)).toMatchObject({
      owner: VARIABLE_MARKER_OWNER,
      markers: [{ message: 'Unresolved variable "hots"', startLineNumber: 1, startColumn: 18, endColumn: 25 }],
    });
    handle.dispose();
    expect(fake.markers.at(-1)).toMatchObject({ owner: VARIABLE_MARKER_OWNER, markers: [] });
  });

  it('completes names only in an attached model, replacing what was typed', () => {
    const text = model('a ${ho');
    const { editor } = fakeEditor(text);
    const handle = attachVariableAssist(editor as never, fake.monacoNS as never, { variables: () => variables });
    const provider = fake.completion.get('json')!;
    const result = provider['provideCompletionItems']!(text, { lineNumber: 1, column: 7 }) as {
      suggestions: { insertText: string; range: unknown }[];
    };
    expect(result.suggestions.map((item) => item.insertText)).toEqual(['host}']);
    expect(result.suggestions[0]?.range).toEqual({
      startLineNumber: 1,
      startColumn: 5,
      endLineNumber: 1,
      endColumn: 7,
    });
    handle.dispose();
    expect(provider['provideCompletionItems']!(text, { lineNumber: 1, column: 7 })).toEqual({ suggestions: [] });
  });

  it('hovers with the value, never a masked one, and an Edit link that opens the scope', () => {
    const text = model('x ${host} ${apiKey}');
    const { editor } = fakeEditor(text);
    const handle = attachVariableAssist(editor as never, fake.monacoNS as never, { variables: () => variables });
    const provider = fake.hover.get('xml')!;
    const hover = provider['provideHover']!(text, { lineNumber: 1, column: 5 }) as {
      contents: { value: string }[];
      range: unknown;
    };
    expect(hover.range).toEqual({ startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 10 });
    expect(hover.contents[0]?.value).toContain('dev.example');
    expect(hover.contents[0]?.value).toContain(`command:${EDIT_VARIABLE_COMMAND}?`);
    const masked = provider['provideHover']!(text, { lineNumber: 1, column: 13 }) as { contents: { value: string }[] };
    expect(masked.contents[0]?.value).toContain('••••••  (secret api_key)');
    expect(provider['provideHover']!(text, { lineNumber: 1, column: 1 })).toBeNull();

    fake.commands.get(EDIT_VARIABLE_COMMAND)!(undefined, { kind: 'environment', id: 'e1' });
    expect(openVariableEditTarget).toHaveBeenCalledWith({ kind: 'environment', id: 'e1' });
    handle.dispose();
  });

  it('offers Set as Variable with a replacement in a request, and without one in a response', () => {
    const text = model('token=abc123');
    const selection = { start: 6, end: 12 };
    const onSetAsVariable = vi.fn();
    const request = fakeEditor(text, selection);
    attachVariableAssist(request.editor as never, fake.monacoNS as never, {
      variables: () => variables,
      onSetAsVariable,
    }).dispose();
    request.actions[0]!.run(request.editor);
    expect(onSetAsVariable).toHaveBeenLastCalledWith('abc123', expect.any(Function));
    (onSetAsVariable.mock.lastCall![1] as (reference: string) => void)('${token}');
    expect(request.edits).toEqual([{ range: selection, text: '${token}', forceMoveMarkers: true }]);

    const response = fakeEditor(text, selection);
    attachVariableAssist(
      response.editor as never,
      fake.monacoNS as never,
      { variables: () => variables, onSetAsVariable },
      { readOnly: true },
    );
    response.actions[0]!.run(response.editor);
    expect(onSetAsVariable).toHaveBeenLastCalledWith('abc123', undefined);
  });
});

describe('hoverMarkdown', () => {
  it('fences the value so it cannot become a link or a command', () => {
    const markdown = hoverMarkdown({ title: 'x', scope: 'Project', value: '[a](command:evil) ```' });
    expect(markdown.value).toContain('```text\n[a](command:evil) `​``\n```');
    expect(markdown.isTrusted).toEqual({ enabledCommands: [EDIT_VARIABLE_COMMAND] });
  });
});
