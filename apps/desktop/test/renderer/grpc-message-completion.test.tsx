/**
 * The Message tab's completion, from the editor's model through to the fields main answers with.
 *
 * The scoping is the thing worth proving. Monaco registers a completion provider per *language*,
 * and every raw JSON body in the app — a REST request body most of all — is edited in that same
 * language. So the provider is asked about a model with no registered schema as well, and it has
 * to answer nothing for it: the pure helpers cannot show that, only running the provider can.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMonaco, mountedModelUris, registeredCompletionProviders } from '../mocks/monaco-editor-react.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const { MessageTab } = await import('../../src/renderer/features/grpc-editor/message-tab.js');
const { registerJsonCompletionOnce } = await import('../../src/renderer/editor/json-completion.js');

const grpcFields = vi.fn();

// The provider is registered once per process, as Monaco's providers are process-global, so it is
// taken once here rather than in `beforeEach`.
registerJsonCompletionOnce(fakeMonaco as never);
const provider = registeredCompletionProviders.at(-1)?.provider as {
  provideCompletionItems: (
    model: unknown,
    position: unknown,
  ) => Promise<{ suggestions: { label: string; insertText: string }[] }>;
};

/** Monaco's `ITextModel`, reduced to what the provider touches. */
function model(uri: string, text: string) {
  return {
    uri: { toString: () => uri },
    getValue: () => text,
    getOffsetAt: (position: { column: number }) => position.column - 1,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
  };
}

/** The registered provider, asked about `marked` with the cursor at its `|`. */
async function complete(uri: string, marked: string) {
  const offset = marked.indexOf('|');
  return provider.provideCompletionItems(model(uri, marked.replace('|', '')), { lineNumber: 1, column: offset + 1 });
}

beforeEach(() => {
  grpcFields.mockReset().mockResolvedValue({
    ok: true,
    value: {
      fullName: 'wirebench.greet.HelloRequest',
      fields: [
        { name: 'name', type: 'string', valueKind: 'scalar', repeated: false },
        { name: 'address', type: 'wirebench.common.Address', valueKind: 'message', repeated: false },
      ],
    },
  });
  installWirebenchApi({ api: { grpcFields } });
  mountedModelUris.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('completion in the Message tab', () => {
  it('offers the request type’s fields, asked for the object the cursor is in', async () => {
    render(
      <MessageTab
        message="{}"
        methodKind="unary"
        apiId="grpc-api-1"
        requestType="wirebench.greet.HelloRequest"
        onChange={() => undefined}
      />,
    );
    const uri = mountedModelUris.at(-1)!;

    const result = await complete(uri, '{"address": {"|"}}');

    expect(grpcFields).toHaveBeenCalledWith({
      apiId: 'grpc-api-1',
      type: 'wirebench.greet.HelloRequest',
      path: ['address'],
    });
    expect(result.suggestions.map((one) => one.label)).toEqual(['name', 'address']);
    // Already inside quotes, so the accepted item brings none of its own.
    expect(result.suggestions[0]?.insertText).toBe('name');
  });

  it('offers nothing for a JSON editor that registered no schema', async () => {
    // A REST raw body is the same Monaco language, and must be left exactly as it was.
    const result = await complete('inmemory://model/rest-body', '{"|"}');

    expect(result.suggestions).toEqual([]);
    expect(grpcFields).not.toHaveBeenCalled();
  });

  it('asks for nothing at all where a key cannot go', async () => {
    render(
      <MessageTab
        message="{}"
        methodKind="unary"
        apiId="grpc-api-1"
        requestType="wirebench.greet.HelloRequest"
        onChange={() => undefined}
      />,
    );
    const uri = mountedModelUris.at(-1)!;

    expect((await complete(uri, '{"name": "A|"}')).suggestions).toEqual([]);
    expect(grpcFields).not.toHaveBeenCalled();
  });

  it('stops completing a model once its editor is gone', async () => {
    const view = render(
      <MessageTab
        message="{}"
        methodKind="unary"
        apiId="grpc-api-1"
        requestType="wirebench.greet.HelloRequest"
        onChange={() => undefined}
      />,
    );
    const uri = mountedModelUris.at(-1)!;
    expect((await complete(uri, '{"|"}')).suggestions).not.toEqual([]);

    view.unmount();

    expect((await complete(uri, '{"|"}')).suggestions).toEqual([]);
  });

  it('completes nothing for a method whose request type is not described', async () => {
    render(<MessageTab message="{}" methodKind="unary" apiId="grpc-api-1" onChange={() => undefined} />);
    const uri = mountedModelUris.at(-1)!;

    expect((await complete(uri, '{"|"}')).suggestions).toEqual([]);
  });
});
