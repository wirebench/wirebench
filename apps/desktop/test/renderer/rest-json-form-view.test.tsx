/**
 * The JSON form view and the body tab's Text / Form switch.
 *
 * The form never writes the body unless the user edits something, so flipping Text → Form → Text is
 * free; every edit goes through the engine's `applyJsonFormEdit` and comes back as pretty JSON.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast: vi.fn() }));

import type { JsonSchema } from '@wirebench/engine/rest';
import { JsonFormView } from '../../src/renderer/features/rest-editor/json-form-view.js';
import { BodyTab, type BodySchemaSource } from '../../src/renderer/features/rest-editor/body-tab.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import type { RestBodyWire, RestRequestPatchWire } from '../../src/shared/wire-types.js';

const PET: JsonSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
    status: { type: 'string', enum: ['available', 'sold'] },
    tags: { type: 'array', items: { type: 'string' } },
    owner: {
      oneOf: [
        { title: 'Person', type: 'object', required: ['first'], properties: { first: { type: 'string' } } },
        { title: 'Company', type: 'object', required: ['company'], properties: { company: { type: 'string' } } },
      ],
    },
  },
};

afterEach(() => {
  cleanup();
  useEditorsStore.getState().reset();
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
});

/** A stateful host, so edits accumulate the way they do under the real body tab. */
function Host({ initial, onText }: { readonly initial: string; readonly onText?: (text: string) => void }) {
  const [text, setText] = useState(initial);
  return (
    <JsonFormView
      text={text}
      schema={PET}
      onChange={(next) => {
        setText(next);
        onText?.(next);
      }}
    />
  );
}

/** A stateful host over any schema. */
function SchemaHost({
  schema,
  initial,
  onText,
}: {
  readonly schema: JsonSchema;
  readonly initial: string;
  readonly onText?: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <JsonFormView
      text={text}
      schema={schema}
      onChange={(next) => {
        setText(next);
        onText?.(next);
      }}
    />
  );
}

function lastJson(spy: ReturnType<typeof vi.fn>): unknown {
  const calls = spy.mock.calls;
  return JSON.parse(calls[calls.length - 1]![0] as string);
}

describe('JsonFormView', () => {
  it('writes a field edit back as pretty JSON', async () => {
    const onText = vi.fn();
    render(<Host initial={'{"name":"a"}'} onText={onText} />);
    const input = screen.getByRole('textbox', { name: 'name' });
    await userEvent.type(input, 'b');
    expect(onText).toHaveBeenLastCalledWith('{\n  "name": "ab"\n}');
  });

  it('writes an integer field as a number', async () => {
    const onText = vi.fn();
    render(<Host initial={'{"name":"a","age":1}'} onText={onText} />);
    await userEvent.type(screen.getByRole('spinbutton', { name: 'age' }), '2');
    expect(lastJson(onText)).toEqual({ name: 'a', age: 12 });
  });

  it('inserts and removes an optional property', async () => {
    const onText = vi.fn();
    render(<Host initial={'{"name":"a"}'} onText={onText} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add age' }));
    expect(lastJson(onText)).toEqual({ name: 'a', age: 0 });
    await userEvent.click(screen.getByRole('button', { name: 'Remove age' }));
    expect(lastJson(onText)).toEqual({ name: 'a' });
    // A required property offers no remove.
    expect(screen.queryByRole('button', { name: 'Remove name' })).toBeNull();
  });

  it('adds and removes an array item', async () => {
    const onText = vi.fn();
    render(<Host initial={'{"name":"a","tags":["x"]}'} onText={onText} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add item to tags' }));
    expect(lastJson(onText)).toEqual({ name: 'a', tags: ['x', ''] });
    await userEvent.click(screen.getByRole('button', { name: 'Remove tags[0]' }));
    expect(lastJson(onText)).toEqual({ name: 'a', tags: [''] });
  });

  it('picks an enum member from a select', async () => {
    const onText = vi.fn();
    render(<Host initial={'{"name":"a","status":"available"}'} onText={onText} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'status' }), 'sold');
    expect(lastJson(onText)).toEqual({ name: 'a', status: 'sold' });
  });

  it('switches a choice to another branch', async () => {
    const onText = vi.fn();
    render(<Host initial={'{"name":"a","owner":{"first":"x"}}'} onText={onText} />);
    expect(screen.getByRole('textbox', { name: 'owner.first' })).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'owner variant' }), 'Company');
    expect(lastJson(onText)).toEqual({ name: 'a', owner: { company: '' } });
    expect(screen.getByRole('textbox', { name: 'owner.company' })).toBeTruthy();
  });

  it('shows invalid JSON with a way back to Text and no fields', async () => {
    const onShowText = vi.fn();
    render(<JsonFormView text="{oops" schema={PET} onChange={vi.fn()} onShowText={onShowText} />);
    expect(screen.getByText('The body is not valid JSON')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back to Text' }));
    expect(onShowText).toHaveBeenCalled();
  });

  it('never writes on render', () => {
    const onChange = vi.fn();
    render(<JsonFormView text={'{"name":"a"}'} schema={PET} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables every control when read-only', () => {
    render(<JsonFormView text={'{"name":"a"}'} schema={PET} onChange={vi.fn()} readOnly />);
    expect(screen.getByRole('textbox', { name: 'name' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Add age' })).toHaveProperty('disabled', true);
  });
});

describe('JsonFormView review fixes', () => {
  it('keeps a picked branch that only its optional properties tell apart', async () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        pet: {
          oneOf: [
            { title: 'Cat', type: 'object', properties: { meow: { type: 'string' } } },
            { title: 'Dog', type: 'object', properties: { bark: { type: 'string' } } },
          ],
        },
      },
    };
    render(<SchemaHost schema={schema} initial={'{"pet":{"meow":"x"}}'} />);
    const select = screen.getByRole('combobox', { name: 'pet variant' });
    await userEvent.selectOptions(select, 'Dog');
    expect(screen.getByRole('combobox', { name: 'pet variant' })).toHaveProperty('value', '1');
  });

  it('shows a null string as an empty input and can write null back', async () => {
    const schema: JsonSchema = { type: 'object', properties: { nick: { type: 'string', nullable: true } } };
    const onText = vi.fn();
    render(<SchemaHost schema={schema} initial={'{"nick":null}'} onText={onText} />);
    const input = screen.getByRole('textbox', { name: 'nick' });
    expect(input).toHaveProperty('value', '');
    expect(input).toHaveProperty('placeholder', 'null');
    await userEvent.type(input, 'x');
    expect(lastJson(onText)).toEqual({ nick: 'x' });
    await userEvent.click(screen.getByRole('button', { name: 'Set nick to null' }));
    expect(lastJson(onText)).toEqual({ nick: null });
  });

  it('offers no null button when the schema does not allow null', () => {
    const schema: JsonSchema = { type: 'object', properties: { nick: { type: 'string' } } };
    render(<SchemaHost schema={schema} initial={'{"nick":"a"}'} />);
    expect(screen.queryByRole('button', { name: 'Set nick to null' })).toBeNull();
  });

  it('disables what sits inside a read-only object', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { meta: { type: 'object', readOnly: true, properties: { id: { type: 'string' } } } },
    };
    render(<SchemaHost schema={schema} initial={'{"meta":{"id":"a"}}'} />);
    expect(screen.getByRole('textbox', { name: 'meta.id' })).toHaveProperty('disabled', true);
  });

  it('does not write a fraction to an integer field', async () => {
    const onText = vi.fn();
    render(<Host initial={'{"name":"a","age":1}'} onText={onText} />);
    const age = screen.getByRole('spinbutton', { name: 'age' });
    await userEvent.clear(age);
    await userEvent.type(age, '2.5');
    expect(lastJson(onText)).toEqual({ name: 'a', age: 2 });
    expect(age.getAttribute('aria-invalid')).toBe('true');
  });

  it('removes an optional number cleared and left', async () => {
    const onText = vi.fn();
    render(<Host initial={'{"name":"a","age":1}'} onText={onText} />);
    await userEvent.clear(screen.getByRole('spinbutton', { name: 'age' }));
    await userEvent.tab();
    expect(lastJson(onText)).toEqual({ name: 'a' });
  });

  it('restores a required number cleared and left', async () => {
    const schema: JsonSchema = { type: 'object', required: ['count'], properties: { count: { type: 'number' } } };
    const onText = vi.fn();
    render(<SchemaHost schema={schema} initial={'{"count":3}'} onText={onText} />);
    const count = screen.getByRole('spinbutton', { name: 'count' });
    await userEvent.clear(count);
    await userEvent.tab();
    expect(onText).not.toHaveBeenCalled();
    expect(count).toHaveProperty('value', '3');
  });
});

function source(result: { mediaType: string; schema: JsonSchema } | null): BodySchemaSource & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    load: (requestId) => {
      calls.push(requestId);
      return Promise.resolve(result);
    },
  };
}

function BodyHost({
  initial,
  schemaSource,
  onPatch,
}: {
  readonly initial: RestBodyWire;
  readonly schemaSource: BodySchemaSource;
  readonly onPatch?: (patch: RestRequestPatchWire) => void;
}) {
  const [body, setBody] = useState(initial);
  return (
    <BodyTab
      requestId="r1"
      body={body}
      settings={{}}
      schemaSource={schemaSource}
      onChange={(patch) => {
        if (patch.body !== undefined) {
          setBody(patch.body);
        }
        onPatch?.(patch);
      }}
    />
  );
}

describe('BodyTab Text / Form switch', () => {
  const RAW: RestBodyWire = { kind: 'raw', language: 'json', text: '{"name":"a"}' };

  it('shows the switch when the body is raw JSON and a schema came back', async () => {
    render(<BodyHost initial={RAW} schemaSource={source({ mediaType: 'application/json', schema: PET })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Form' }));
    expect(screen.getByTestId('json-form-view')).toBeTruthy();
    expect(useEditorsStore.getState().restBodyViewFor('r1')).toBe('form');
  });

  it('hides the switch when there is no schema', async () => {
    const schemaSource = source(null);
    render(<BodyHost initial={RAW} schemaSource={schemaSource} />);
    await waitFor(() => {
      expect(schemaSource.calls).toEqual(['r1']);
    });
    expect(screen.queryByRole('button', { name: 'Form' })).toBeNull();
  });

  it('hides the switch when the language is not JSON', async () => {
    const schemaSource = source({ mediaType: 'application/json', schema: PET });
    render(<BodyHost initial={{ kind: 'raw', language: 'xml', text: '<a/>' }} schemaSource={schemaSource} />);
    await waitFor(() => {
      expect(schemaSource.calls.length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: 'Form' })).toBeNull();
  });

  it('leaves the text unchanged going Text → Form → Text', async () => {
    const onPatch = vi.fn();
    const text = '{ "name":   "a" }';
    render(
      <BodyHost
        initial={{ kind: 'raw', language: 'json', text }}
        schemaSource={source({ mediaType: 'application/json', schema: PET })}
        onPatch={onPatch}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Form' }));
    await userEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(onPatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('rest-body-editor')).toBeTruthy();
  });

  it('remembers Form per request and edits the body from it', async () => {
    useEditorsStore.getState().setRestBodyView('r1', 'form');
    const onPatch = vi.fn();
    render(
      <BodyHost
        initial={RAW}
        schemaSource={source({ mediaType: 'application/json', schema: PET })}
        onPatch={onPatch}
      />,
    );
    await userEvent.type(await screen.findByRole('textbox', { name: 'name' }), 'b');
    expect(onPatch).toHaveBeenLastCalledWith({
      body: { ...RAW, text: JSON.stringify({ name: 'ab' }, null, DEFAULT_PREFERENCES_WIRE.editor.tabSize) },
    });
  });

  it('writes a form edit with the editor tab size', async () => {
    usePreferencesStore.setState({
      preferences: {
        ...DEFAULT_PREFERENCES_WIRE,
        editor: { ...DEFAULT_PREFERENCES_WIRE.editor, tabSize: 4 },
      },
    });
    useEditorsStore.getState().setRestBodyView('r1', 'form');
    const onPatch = vi.fn();
    render(
      <BodyHost
        initial={RAW}
        schemaSource={source({ mediaType: 'application/json', schema: PET })}
        onPatch={onPatch}
      />,
    );
    await userEvent.type(await screen.findByRole('textbox', { name: 'name' }), 'b');
    expect(onPatch).toHaveBeenLastCalledWith({ body: { ...RAW, text: '{\n    "name": "ab"\n}' } });
  });

  it('goes back to Text from an invalid body', async () => {
    useEditorsStore.getState().setRestBodyView('r1', 'form');
    render(
      <BodyHost
        initial={{ kind: 'raw', language: 'json', text: '{' }}
        schemaSource={source({ mediaType: 'application/json', schema: PET })}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Back to Text' }));
    expect(useEditorsStore.getState().restBodyViewFor('r1')).toBe('text');
    expect(screen.getByTestId('rest-body-editor')).toBeTruthy();
  });
});
