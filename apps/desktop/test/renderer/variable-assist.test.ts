/**
 * The editor's variable help (#340), Monaco-free: what `${` completes to, what a reference resolves
 * to, which references are marked, and the reference a variable is inserted as.
 */
import { describe, expect, it } from 'vitest';
import { propertyReferences } from '@wirebench/engine/rest';
import {
  classifyReference,
  completionContext,
  completionItems,
  hoverContent,
  referenceText,
  unresolvedReferences,
  type RequestVariables,
} from '../../src/renderer/editor/variable-assist.js';

const list: RequestVariables = {
  entries: [
    {
      name: 'host',
      scope: 'Env',
      value: 'dev.example',
      masked: false,
      shadowed: false,
      edit: { kind: 'environment', id: 'e1' },
    },
    {
      name: 'host',
      scope: 'Project',
      value: 'project.example',
      masked: false,
      shadowed: true,
      edit: { kind: 'project', projectId: 'p1' },
    },
    {
      name: 'apiKey',
      scope: 'Project',
      masked: true,
      secretName: 'api_key',
      shadowed: false,
      edit: { kind: 'project', projectId: 'p1' },
    },
    { name: 'region', scope: 'Global', value: 'eu', masked: false, shadowed: false, edit: { kind: 'globals' } },
    { name: 'HOME', scope: 'System', masked: true, shadowed: false },
  ],
  secretNames: ['api_key'],
};

describe('completionContext', () => {
  it('recognises each open-reference form at the caret', () => {
    expect(completionContext('url ${ho')).toEqual({ kind: 'name', prefix: 'ho', start: 6 });
    expect(completionContext('${')).toEqual({ kind: 'name', prefix: '', start: 2 });
    expect(completionContext('${#')).toEqual({ kind: 'scope', prefix: '', start: 3 });
    expect(completionContext('${#Pro')).toEqual({ kind: 'scope', prefix: 'Pro', start: 3 });
    expect(completionContext('${#Env#h')).toEqual({ kind: 'name', scope: 'Env', prefix: 'h', start: 7 });
    expect(completionContext('${secret:ap')).toEqual({ kind: 'secret', prefix: 'ap', start: 9 });
  });

  it('recognises a dynamic name in either of its forms', () => {
    expect(completionContext('${$gu')).toEqual({ kind: 'dynamic', prefix: 'gu', start: 3 });
    expect(completionContext('${#Dynamic#gu')).toEqual({ kind: 'dynamic', prefix: 'gu', start: 11 });
  });

  it('stays out of the escape and a closed reference', () => {
    expect(completionContext('$${ho')).toBeUndefined();
    expect(completionContext('$${$gu')).toBeUndefined();
    expect(completionContext('${host} x')).toBeUndefined();
    expect(completionContext('plain')).toBeUndefined();
  });
});

describe('completionItems', () => {
  it('offers the chain shorthand, the explicit form for a shadowed entry, and secrets', () => {
    const items = completionItems({ kind: 'name', prefix: '', start: 2 }, list, false);
    expect(items.map((item) => [item.label, item.insertText, item.detail])).toEqual([
      ['host', 'host}', 'Environment'],
      ['host', '#Project#host}', 'Project (shadowed)'],
      ['apiKey', 'apiKey}', 'Project'],
      ['region', 'region}', 'Globals'],
      ['secret:api_key', 'secret:api_key}', 'Secret'],
    ]);
    // A masked value is never shown.
    expect(items[2]?.documentation).toBe('••••••  (secret api_key)');
    expect(items[0]?.documentation).toBe('dev.example');
  });

  it('leaves the brace off when one already follows the caret', () => {
    expect(completionItems({ kind: 'name', prefix: '', start: 2 }, list, true)[0]?.insertText).toBe('host');
  });

  it('lists the scopes after ${#, and one scope’s names, System included, after ${#Scope#', () => {
    expect(
      completionItems({ kind: 'scope', prefix: '', start: 3 }, list, false).map((item) => item.insertText),
    ).toEqual(['Env#', 'Project#', 'Workspace#', 'Global#', 'System#', 'Dynamic#']);
    expect(
      completionItems({ kind: 'name', scope: 'System', prefix: '', start: 10 }, list, false).map((item) => item.label),
    ).toEqual(['HOME']);
    expect(
      completionItems({ kind: 'name', scope: 'Project', prefix: '', start: 11 }, list, false).map(
        (item) => item.insertText,
      ),
    ).toEqual(['host}', 'apiKey}']);
  });

  it('lists the dynamic generators after ${$, with what each gives', () => {
    const items = completionItems({ kind: 'dynamic', prefix: 'gu', start: 3 }, list, false);
    expect(items.map((item) => item.insertText)).toEqual(['guid}']);
    expect(items[0]?.detail).toBe('Dynamic');
    expect(items[0]?.documentation).not.toBe('');
    expect(completionItems({ kind: 'dynamic', prefix: '', start: 3 }, list, true)[0]?.insertText).not.toContain('}');
  });

  it('lists secret names after ${secret:', () => {
    expect(completionItems({ kind: 'secret', prefix: '', start: 9 }, list, false)).toEqual([
      { label: 'api_key', insertText: 'api_key}', detail: 'Secret', documentation: '••••••' },
    ]);
  });
});

function classify(text: string, variables: RequestVariables | undefined = list) {
  const [reference] = propertyReferences(text);
  return classifyReference(reference!, variables);
}

describe('classifyReference', () => {
  it('resolves the shorthand to the nearest scope, and an explicit scope to its own entry', () => {
    expect(classify('${host}')).toMatchObject({ status: 'resolved', entry: { scope: 'Env' } });
    expect(classify('${#Project#host}')).toMatchObject({ status: 'resolved', entry: { scope: 'Project' } });
    expect(classify('${#System#HOME}')).toMatchObject({ status: 'resolved', entry: { scope: 'System' } });
    expect(classify('${secret:api_key}')).toEqual({ status: 'secret', name: 'api_key' });
  });

  it('marks a missing name, a missing secret, an unknown scope and an unterminated reference', () => {
    expect(classify('${hots}')).toMatchObject({ status: 'unresolved' });
    expect(classify('${#Env#region}')).toMatchObject({ status: 'unresolved' });
    expect(classify('${secret:nope}')).toMatchObject({ status: 'unresolved' });
    expect(classify('${#Foo#x}')).toMatchObject({ status: 'unresolved' });
    expect(classify('${host')).toMatchObject({ status: 'unresolved' });
  });

  it('knows a dynamic generator by its name or an alias, and marks an unknown one', () => {
    expect(classify('${$guid}')).toMatchObject({ status: 'dynamic', generator: { name: 'guid' } });
    expect(classify('${#Dynamic#isoTimestamp(+1d)}')).toMatchObject({
      status: 'dynamic',
      generator: { name: 'isoTimestamp' },
    });
    expect(classify('${$nope}')).toEqual({ status: 'unresolved', name: '$nope' });
  });

  it('never marks what only a run knows, a built name, or anything before the list arrives', () => {
    expect(classify('${#Sequence#id}')).toEqual({ status: 'unknown' });
    expect(classify('${${#Env#which}}')).toEqual({ status: 'unknown' });
    expect(classifyReference(propertyReferences('${hots}')[0]!, undefined)).toEqual({ status: 'unknown' });
  });
});

describe('unresolvedReferences', () => {
  it('returns the spans to mark', () => {
    expect(
      unresolvedReferences('${host}/${hots}/${#Env#nope}', list).map((ref) => [ref.start, ref.end, ref.name]),
    ).toEqual([
      [8, 15, 'hots'],
      [16, 28, 'nope'],
    ]);
  });
});

describe('referenceText', () => {
  it('writes the shorthand when the chain reaches the scope, and the explicit form otherwise', () => {
    expect(referenceText('host', 'Env', list)).toBe('${host}');
    expect(referenceText('host', 'Project', list)).toBe('${#Project#host}');
    expect(referenceText('fresh', 'Global', list)).toBe('${fresh}');
    expect(referenceText('region', 'Project', list)).toBe('${region}');
    expect(referenceText('HOME', 'System', list)).toBe('${#System#HOME}');
  });
});

describe('hoverContent for a dynamic value', () => {
  it('says what the generator gives and that each send makes a new one', () => {
    const hover = hoverContent(classify('${$guid}'), '${$guid}');
    expect(hover).toMatchObject({ title: '$guid', scope: 'Dynamic' });
    expect(hover?.value).toContain('generated for each send');
    expect(hover).not.toHaveProperty('edit');
    expect(hoverContent(classify('${$nope}'), '${$nope}')).toMatchObject({
      scope: 'Unresolved',
      value: 'No dynamic value is named "nope".',
    });
  });
});

describe('hoverContent', () => {
  it('shows the value and scope, or the mask, with where to edit it', () => {
    expect(hoverContent(classify('${host}'), '${host}')).toEqual({
      title: 'host',
      scope: 'Environment',
      value: 'dev.example',
      edit: { kind: 'environment', id: 'e1' },
    });
    expect(hoverContent(classify('${apiKey}'), '${apiKey}')).toMatchObject({ value: '••••••  (secret api_key)' });
    expect(hoverContent(classify('${#System#HOME}'), '${#System#HOME}')).toMatchObject({
      scope: 'System',
      value: '••••••  (environment variable)',
    });
    expect(hoverContent(classify('${secret:api_key}'), '${secret:api_key}')).toEqual({
      title: 'api_key',
      scope: 'Secret',
      value: '••••••',
    });
    expect(hoverContent(classify('${hots}'), '${hots}')).toEqual({
      title: 'hots',
      scope: 'Unresolved',
      value: 'No variable named "hots" is in scope for this request.',
      unresolved: true,
    });
    expect(hoverContent(classify('${#Sequence#id}'), '${#Sequence#id}')).toBeUndefined();
  });
});

describe('data columns (#560)', () => {
  const withData: RequestVariables = { ...list, dataColumns: ['user', 'host'] };

  it('offers a column after the chain, explicitly when a chain scope has its name', () => {
    const items = completionItems({ kind: 'name', prefix: '', start: 2 }, withData, false);
    expect(items.map((item) => [item.label, item.insertText, item.detail])).toEqual([
      ['host', 'host}', 'Environment'],
      ['host', '#Project#host}', 'Project (shadowed)'],
      ['apiKey', 'apiKey}', 'Project'],
      ['region', 'region}', 'Globals'],
      ['user', 'user}', 'Data row'],
      ['host', '#Data#host}', 'Data row (shadowed)'],
      ['secret:api_key', 'secret:api_key}', 'Secret'],
    ]);
  });

  it('completes ${#Data# to the columns, and offers Data as a scope only when there are some', () => {
    expect(completionContext('${#Data#us')).toEqual({ kind: 'data', prefix: 'us', start: 8 });
    expect(
      completionItems({ kind: 'data', prefix: 'us', start: 8 }, withData, false).map((item) => item.insertText),
    ).toEqual(['user}']);
    const scopes = (variables: RequestVariables) =>
      completionItems({ kind: 'scope', prefix: '', start: 3 }, variables, false).map((item) => item.label);
    expect(scopes(withData)).toContain('Data');
    expect(scopes(list)).not.toContain('Data');
  });

  it('resolves a column by the shorthand only after the chain, and never marks ${#Data#…} unknown to it', () => {
    expect(classify('${user}', withData)).toEqual({ status: 'data', name: 'user' });
    expect(classify('${host}', withData)).toMatchObject({ status: 'resolved', entry: { scope: 'Env' } });
    expect(classify('${#Data#host}', withData)).toEqual({ status: 'data', name: 'host' });
    expect(classify('${user}')).toMatchObject({ status: 'unresolved' });
    // Without a known data file, only a run can tell.
    expect(classify('${#Data#user}')).toEqual({ status: 'unknown' });
    expect(hoverContent(classify('${user}', withData), '${user}')).toMatchObject({ title: 'user', scope: 'Data row' });
  });
});
