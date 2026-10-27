/**
 * The MCP request's Arguments tab (#79). A `tools/call` sends one JSON object, edited in Monaco's
 * JSON language and completed from the tool's `inputSchema` when the catalogue has the tool. A
 * `prompts/get` sends strings, so its arguments are a key-value table, with the prompt's declared
 * arguments offered. The other methods take none, and the tab says so.
 *
 * The completion source is registered against this editor's model alone, as the gRPC message
 * editor's is, so no other JSON editor in the app gains the tool's fields. Markers come from main,
 * once typing pauses: the text checked as JSON, then against the tool's `inputSchema`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { Button } from '../../components/button.js';
import { EmptyState } from '../../components/empty-state.js';
import { KvTable } from '../../components/kv-table.js';
import { CodeEditor } from '../../editor/code-editor.js';
import {
  clearJsonCompletionSource,
  registerJsonCompletionOnce,
  setJsonCompletionSource,
} from '../../editor/json-completion.js';
import { SAVE_KEYBINDING, SEND_KEYBINDING } from '../../editor/monaco.js';
import type { McpCatalogueWire, McpOperationWire } from '@shared/kinds/mcp/wire.js';
import { useEditorVariableAssist } from '../environments/variable-assist-provider.js';
import { toolArgumentsSource } from './arguments-completion.js';
import { MCP_ARGUMENTS_CHECK_DEBOUNCE_MS, refreshMcpArgumentsMarkers } from './arguments-markers.js';

type ToolCall = Extract<McpOperationWire, { method: 'tools/call' }>;
type PromptGet = Extract<McpOperationWire, { method: 'prompts/get' }>;
type CatalogueTool = NonNullable<McpCatalogueWire['tools']>[number];
type CataloguePrompt = NonNullable<McpCatalogueWire['prompts']>[number];

export interface ArgumentsTabProps {
  readonly operation: McpOperationWire;
  readonly catalogue: McpCatalogueWire | undefined;
  readonly onChange: (operation: McpOperationWire) => void;
  readonly onSend?: () => void;
  readonly onSave?: () => void;
}

/** The catalogue's entry for the tool a call names, if it has one. */
export function catalogueTool(catalogue: McpCatalogueWire | undefined, name: string): CatalogueTool | undefined {
  return catalogue?.tools?.find((tool) => tool.name === name);
}

function cataloguePrompt(catalogue: McpCatalogueWire | undefined, name: string): CataloguePrompt | undefined {
  return catalogue?.prompts?.find((prompt) => prompt.name === name);
}

/** A tool call's JSON, completed from the tool's input schema. */
function ToolArguments({
  operation,
  tool,
  onChange,
  onSend,
  onSave,
}: {
  readonly operation: ToolCall;
  readonly tool: CatalogueTool | undefined;
  readonly onChange: (operation: McpOperationWire) => void;
  readonly onSend?: (() => void) | undefined;
  readonly onSave?: (() => void) | undefined;
}) {
  const attachVariables = useEditorVariableAssist();
  const [modelUri, setModelUri] = useState<string | undefined>(undefined);
  const inputSchema = tool?.inputSchema;
  const monacoRef = useRef<typeof Monaco | undefined>(undefined);
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null);

  // Keyed on the schema, not set once at mount: naming another tool changes what this same editor
  // completes against, and the editor is not remounted for it.
  useEffect(() => {
    if (modelUri === undefined || inputSchema === undefined) {
      return undefined;
    }
    setJsonCompletionSource(modelUri, toolArgumentsSource(inputSchema));
    return () => {
      clearJsonCompletionSource(modelUri);
    };
  }, [modelUri, inputSchema]);

  // Checked as typed, once typing pauses, and again when the tool named (so its schema) changes.
  useEffect(() => {
    if (modelUri === undefined) {
      return undefined;
    }
    const timer = setTimeout(() => {
      void refreshMcpArgumentsMarkers(monacoRef.current, modelRef.current, operation.arguments, inputSchema);
    }, MCP_ARGUMENTS_CHECK_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [modelUri, operation.arguments, inputSchema]);

  const hint =
    operation.tool === ''
      ? 'Name a tool to call. Its arguments are one JSON object; blank sends {}.'
      : tool === undefined
        ? `"${operation.tool}" is not in the catalogue, so its arguments are not completed. Blank sends {}.`
        : (tool.description ?? 'One JSON object, checked against the tool’s input schema when sent. Blank sends {}.');

  return (
    <div data-testid="mcp-arguments" className="flex h-full min-h-0 flex-col gap-2 p-3">
      <p data-testid="mcp-arguments-hint" className="shrink-0 truncate text-xs text-fg-subtle" title={hint}>
        {hint}
      </p>
      <div className="min-h-0 flex-1 overflow-hidden rounded border border-hairline-strong">
        <CodeEditor
          value={operation.arguments}
          language="json"
          ariaLabel="Tool arguments"
          onChange={(text) => {
            onChange({ ...operation, arguments: text });
          }}
          onMount={(editor, monacoNS) => {
            editor.addCommand(SEND_KEYBINDING, () => {
              onSend?.();
            });
            editor.addCommand(SAVE_KEYBINDING, () => {
              onSave?.();
            });
            attachVariables(editor, monacoNS);
            const model = editor.getModel();
            if (model === null) {
              return;
            }
            registerJsonCompletionOnce(monacoNS as typeof Monaco);
            monacoRef.current = monacoNS as typeof Monaco;
            modelRef.current = model;
            setModelUri(model.uri.toString());
          }}
        />
      </div>
    </div>
  );
}

/** A prompt's string arguments, with the ones it declares offered. */
function PromptArguments({
  operation,
  prompt,
  onChange,
}: {
  readonly operation: PromptGet;
  readonly prompt: CataloguePrompt | undefined;
  readonly onChange: (operation: McpOperationWire) => void;
}) {
  const declared = useMemo(() => prompt?.arguments ?? [], [prompt]);
  const missing = declared.filter((argument) => !operation.arguments.some((row) => row.name === argument.name));
  return (
    <div data-testid="mcp-prompt-arguments" className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-3">
      {declared.length > 0 && (
        <div className="flex shrink-0 items-center gap-2">
          <p data-testid="mcp-prompt-declared" className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
            {`Declared: ${declared.map((argument) => `${argument.name}${argument.required === true ? ' (required)' : ''}`).join(', ')}`}
          </p>
          {missing.length > 0 && (
            <Button
              variant="secondary"
              data-testid="mcp-prompt-add-declared"
              onClick={() => {
                onChange({
                  ...operation,
                  arguments: [
                    ...operation.arguments,
                    ...missing.map((argument) => ({
                      name: argument.name,
                      value: '',
                      enabled: true,
                      ...(argument.description !== undefined ? { description: argument.description } : {}),
                    })),
                  ],
                });
              }}
            >
              Add declared arguments
            </Button>
          )}
        </div>
      )}
      <KvTable
        label="Prompt arguments"
        testidPrefix="mcp-prompt-arg"
        rows={operation.arguments}
        allowDuplicates={false}
        emptyMessage="No arguments. Type a name to add one."
        onChange={(rows) => {
          onChange({ ...operation, arguments: [...rows] });
        }}
      />
    </div>
  );
}

/** The Arguments tab. */
export function ArgumentsTab({ operation, catalogue, onChange, onSend, onSave }: ArgumentsTabProps) {
  if (operation.method === 'tools/call') {
    return (
      <ToolArguments
        operation={operation}
        tool={catalogueTool(catalogue, operation.tool)}
        onChange={onChange}
        onSend={onSend}
        onSave={onSave}
      />
    );
  }
  if (operation.method === 'prompts/get') {
    return (
      <PromptArguments
        operation={operation}
        prompt={cataloguePrompt(catalogue, operation.prompt)}
        onChange={onChange}
      />
    );
  }
  return (
    <div data-testid="mcp-arguments-none" className="h-full">
      <EmptyState
        title="No arguments"
        description={
          operation.method === 'resources/read'
            ? 'A resource is read by its URI alone; set it in the bar above.'
            : `${operation.method} takes no arguments: it lists what the server has.`
        }
      />
    </div>
  );
}
