/**
 * The Form view: a schema-driven editor for a request's SOAP Body, two-way
 * synced with the XML text.
 *
 * The XML text is always the single source of truth. The tree comes from main
 * (`xml.form`, where the `SchemaSet` lives) and is re-fetched, debounced, every
 * time the envelope text changes from somewhere else. Two edit paths lead back:
 *
 * - **Value edits** splice straight into the envelope at the node's exact
 *   `valueRange` and commit immediately — no IPC, no re-fetch, so typing never
 *   waits on a round trip. The local tree's value is updated optimistically.
 * - **Structural edits** (add an optional element, add/remove a repetition,
 *   select a choice branch, set a value on a node that is not in the text yet)
 *   go to main as `xml.applyFormEdit`, which re-renders only the Body's child
 *   elements and hands back the whole new envelope. The tree is then re-fetched.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../../../components/empty-state.js';
import { showToast } from '../../../components/toast.js';
import { ipc } from '../../../state/ipc-client.js';
import type { FormEditWire, FormNodeWire, TextRangeWire } from '../../../../shared/wire-types.js';
import type { IpcError } from '../../../../shared/ipc.js';
import type { FormViewType } from '../../../state/editors.js';
import { FieldEditor, NodeBadges, hintFor, isEmptyValue } from './form-fields.js';
import { GetDataDialog } from './get-data-dialog.js';
import { escapeForRange } from './xml-model.js';

/** Which fields the view shows. Persisted per request in the editors store (see
 * `useEditorsStore().formViewTypeFor`), so it survives a tab switch or remount. */
export type { FormViewType };

export const FORM_VIEW_TYPES: readonly { readonly id: FormViewType; readonly label: string }[] = [
  { id: 'full', label: 'Full' },
  { id: 'required', label: 'Required only' },
  { id: 'non-empty', label: 'Non-empty' },
];

/** The `xml.form` / `xml.applyFormEdit` pair this view needs; injectable for tests. */
export interface FormSource {
  form(request: {
    interfaceId: string;
    bindingName: string;
    operationName: string;
    envelopeXml: string;
  }): Promise<
    { ok: true; value: { root: FormNodeWire; bodyRange: TextRangeWire; problems: string[] } } | { ok: false }
  >;
  applyFormEdit(request: {
    interfaceId: string;
    bindingName: string;
    operationName: string;
    envelopeXml: string;
    edit: FormEditWire;
  }): Promise<
    { ok: true; value: { envelopeXml: string; changedRange: TextRangeWire } } | { ok: false; error?: IpcError }
  >;
}

export interface FormViewProps {
  readonly xml: string;
  readonly interfaceId: string;
  /** Clark-notation binding QName; the operation's body element is what the form models. */
  readonly bindingName: string;
  readonly operationName: string;
  /** Splices a value into the envelope text at `range` and commits it. */
  readonly onValueEdit: (range: TextRangeWire, value: string) => void;
  /** Replaces the whole envelope after a structural edit. */
  readonly onEnvelopeReplace: (xml: string) => void;
  readonly viewType: FormViewType;
  readonly onViewTypeChange: (viewType: FormViewType) => void;
  /** `window.wirebench.xml` by default; injectable for tests. */
  readonly source?: FormSource;
}

/** Long enough to coalesce a burst of keystrokes made in the XML view, short enough to feel live. */
const REFETCH_DEBOUNCE_MS = 250;

/** Replaces the node with `id` in a tree, rebuilding only the spine above it. */
function replaceNode(node: FormNodeWire, id: string, next: (node: FormNodeWire) => FormNodeWire): FormNodeWire {
  if (node.id === id) {
    return next(node);
  }
  return {
    ...node,
    children: node.children.map((child) => replaceNode(child, id, next)),
    ...(node.repeat !== undefined
      ? { repeat: { ...node.repeat, instances: node.repeat.instances.map((i) => replaceNode(i, id, next)) } }
      : {}),
  };
}

/**
 * Moves every range at or after `from` by `delta`. A value splice changes the
 * document's length, so without this the *next* field's range — captured when
 * the tree was built — would point at the wrong text.
 */
function shiftRanges(node: FormNodeWire, from: number, delta: number): FormNodeWire {
  const range = node.valueRange;
  const shifted =
    range === undefined || range.start < from ? range : { start: range.start + delta, end: range.end + delta };
  return {
    ...node,
    ...(shifted !== undefined ? { valueRange: shifted } : {}),
    children: node.children.map((child) => shiftRanges(child, from, delta)),
    ...(node.repeat !== undefined
      ? {
          repeat: {
            ...node.repeat,
            instances: node.repeat.instances.map((instance) => shiftRanges(instance, from, delta)),
          },
        }
      : {}),
  };
}

/** True when a node (or anything under it) has a non-placeholder value in the document. */
function hasContent(node: FormNodeWire): boolean {
  if (node.kind === 'field' || node.kind === 'attribute') {
    return node.present && !isEmptyValue(node.value);
  }
  if (node.kind === 'any') {
    return node.present;
  }
  return [...node.children, ...(node.repeat?.instances ?? [])].some(hasContent);
}

/** Whether the current view type shows this node at all. */
function visibleUnder(node: FormNodeWire, viewType: FormViewType): boolean {
  if (viewType === 'full') {
    return true;
  }
  if (viewType === 'required') {
    // A required branch's optional descendants are hidden, but a required node
    // nested under an optional group must still be reachable — hence the
    // recursive check rather than a flat `node.required`.
    return node.required || node.children.some((child) => visibleUnder(child, viewType));
  }
  return hasContent(node);
}

export function FormView({
  xml,
  interfaceId,
  bindingName,
  operationName,
  onValueEdit,
  onEnvelopeReplace,
  viewType,
  onViewTypeChange,
  source,
}: FormViewProps) {
  const [root, setRoot] = useState<FormNodeWire | undefined>(undefined);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [failed, setFailed] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [getDataFor, setGetDataFor] = useState<FormNodeWire | undefined>(undefined);

  // The text this view itself just wrote. A value splice re-enters as a new
  // `xml` prop; without this the debounced re-fetch would immediately rebuild
  // the tree under the user's cursor on every keystroke.
  const ownEditRef = useRef<string | undefined>(undefined);
  // Bumped by every optimistic value edit. A `xml.form` reply that was issued
  // before the user typed describes an older document, so applying it would
  // throw away the edit (and, worse, restore stale ranges) — it is dropped.
  const editSeqRef = useRef(0);
  const api = useMemo<FormSource>(() => source ?? ipc().xml, [source]);

  useEffect(() => {
    if (ownEditRef.current === xml) {
      return;
    }
    let cancelled = false;
    const issuedAt = editSeqRef.current;
    const timer = setTimeout(() => {
      void api.form({ interfaceId, bindingName, operationName, envelopeXml: xml }).then((result) => {
        if (cancelled || editSeqRef.current !== issuedAt) {
          return;
        }
        if (!result.ok) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setRoot(result.value.root);
        setProblems(result.value.problems);
      });
    }, REFETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, xml, interfaceId, bindingName, operationName]);

  const structuralEdit = useCallback(
    (edit: FormEditWire) => {
      void api.applyFormEdit({ interfaceId, bindingName, operationName, envelopeXml: xml, edit }).then((result) => {
        if (result.ok) {
          // Deliberately not marked as an own edit: a structural change alters
          // the shape, so the tree must be rebuilt from the new text.
          onEnvelopeReplace(result.value.envelopeXml);
          return;
        }
        // Leave the form state exactly as it was: the envelope is not replaced, so the tree
        // the user was looking at (and every ghost/collapsed-state decision built on it)
        // stays valid. Silently dropping this would look like the click did nothing.
        const error = result.error;
        showToast(
          error === undefined ? 'Could not apply that change to the request' : `${error.message} (${error.code})`,
        );
      });
    },
    [api, xml, interfaceId, bindingName, operationName, onEnvelopeReplace],
  );

  const setValue = useCallback(
    (node: FormNodeWire, value: string) => {
      if (node.valueRange === undefined) {
        // Not in the text yet (an omitted optional, or a self-closing element):
        // main must write the element before the value can be spliced.
        structuralEdit({ kind: 'set-value', nodeId: node.id, value });
        return;
      }
      const range = node.valueRange;
      editSeqRef.current += 1;
      // Must match exactly what `onValueEdit` (→ `applyValueEdit`) writes, quote-escaping
      // included for an attribute context — otherwise the delta below is wrong and every
      // later field's `valueRange` drifts out from under it.
      const escaped = escapeForRange(xml, range, value);
      const delta = escaped.length - (range.end - range.start);
      setRoot((current) => {
        if (current === undefined) {
          return current;
        }
        const updated = replaceNode(current, node.id, (n) => ({
          ...n,
          value,
          valueRange: { start: range.start, end: range.start + escaped.length },
        }));
        return delta === 0 ? updated : shiftRanges(updated, range.end, delta);
      });
      ownEditRef.current = xml.slice(0, range.start) + escaped + xml.slice(range.end);
      onValueEdit(range, value);
    },
    [xml, onValueEdit, structuralEdit],
  );

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toolbar = (
    <div className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1">
      <div role="radiogroup" aria-label="Form view type" className="flex items-center gap-1">
        {FORM_VIEW_TYPES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={item.id === viewType}
            onClick={() => onViewTypeChange(item.id)}
            className={`rounded-sm px-2 text-xs ${
              item.id === viewType ? 'bg-surface-active text-fg-default' : 'text-fg-subtle hover:bg-surface-hover'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );

  if (failed) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {toolbar}
        <EmptyState
          title="Can't build a form for this operation"
          description="The schema behind this request could not be resolved. Edit the request in the XML view instead."
        />
      </div>
    );
  }

  if (root === undefined) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {toolbar}
        <EmptyState title="Reading the schema…" description="The form for this request is being built." />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      {problems.length > 0 && (
        <p className="shrink-0 border-b border-hairline px-2 py-1 text-xs text-warning" role="status">
          {problems[0]}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="form-view">
        <NodeRows
          node={root}
          depth={0}
          viewType={viewType}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          onSetValue={setValue}
          onEdit={structuralEdit}
          onGetData={setGetDataFor}
        />
      </div>
      <GetDataDialog
        open={getDataFor !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setGetDataFor(undefined);
          }
        }}
        fieldLabel={getDataFor?.label ?? ''}
        onInsert={(reference) => {
          if (getDataFor !== undefined) {
            setValue(getDataFor, reference);
          }
          setGetDataFor(undefined);
        }}
      />
    </div>
  );
}

interface RowsProps {
  readonly node: FormNodeWire;
  readonly depth: number;
  readonly viewType: FormViewType;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggleCollapsed: (id: string) => void;
  readonly onSetValue: (node: FormNodeWire, value: string) => void;
  readonly onEdit: (edit: FormEditWire) => void;
  readonly onGetData: (node: FormNodeWire) => void;
}

/** Renders one node and, unless collapsed, everything under it. */
function NodeRows(props: RowsProps) {
  const { node, depth, viewType, collapsed, onToggleCollapsed, onSetValue, onEdit, onGetData } = props;
  if (!visibleUnder(node, viewType)) {
    return null;
  }
  const pad = { paddingLeft: depth * 14 };

  if (node.kind === 'any') {
    return (
      <div style={pad} className="py-0.5 text-sm text-fg-subtle" data-testid="form-any">
        <span className="font-medium">{node.label}</span>
        <span className="ml-2 text-xs italic">Edit in XML</span>
      </div>
    );
  }

  if (node.kind === 'repeat') {
    const repeat = node.repeat;
    return (
      <div style={pad} data-testid="form-repeat" data-node-id={node.id}>
        <div className="flex items-center gap-2 py-0.5 text-sm">
          <span className="font-medium text-fg-default">{node.label === '' ? 'items' : node.label}</span>
          <NodeBadges node={node} />
          <button
            type="button"
            disabled={repeat?.canAdd !== true}
            aria-label={`Add ${node.label}`}
            className="rounded-sm px-1 text-xs text-accent hover:bg-surface-hover disabled:opacity-40"
            onClick={() => onEdit({ kind: 'add-repeat', nodeId: node.id })}
          >
            + Add
          </button>
        </div>
        {(repeat?.instances ?? []).map((instance, index) => (
          <div key={instance.id} className="border-l border-hairline pl-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-fg-faint">#{index + 1}</span>
              <button
                type="button"
                disabled={repeat?.canRemove !== true}
                aria-label={`Remove ${node.label} ${index + 1}`}
                className="rounded-sm px-1 text-xs text-fg-subtle hover:bg-surface-hover disabled:opacity-40"
                onClick={() => onEdit({ kind: 'remove-repeat', nodeId: node.id, index })}
              >
                Remove
              </button>
            </div>
            <NodeRows {...props} node={instance} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (node.kind === 'choice') {
    const selected = node.choice?.selected;
    return (
      <div style={pad} data-testid="form-choice" data-node-id={node.id}>
        <div role="tablist" aria-label="Choice" className="flex items-center gap-1 py-0.5">
          {node.children.map((branch, index) => (
            <button
              key={branch.id}
              type="button"
              role="tab"
              aria-selected={index === selected}
              onClick={() => onEdit({ kind: 'select-choice', nodeId: node.id, index })}
              className={`rounded-sm px-2 text-xs ${
                index === selected ? 'bg-surface-active text-fg-default' : 'text-fg-subtle hover:bg-surface-hover'
              }`}
            >
              {branch.label === '' ? `Option ${index + 1}` : branch.label}
            </button>
          ))}
        </div>
        {selected !== undefined && node.children[selected] !== undefined && (
          <NodeRows {...props} node={node.children[selected]} depth={depth + 1} />
        )}
      </div>
    );
  }

  if (node.kind === 'field' || node.kind === 'attribute') {
    const hint = hintFor(node.type);
    return (
      <div style={pad} className="py-0.5" data-testid="form-field" data-node-id={node.id}>
        <div className={`flex items-center gap-2 text-sm ${node.present ? '' : 'opacity-60'}`}>
          <span className="w-40 shrink-0 truncate text-fg-default" title={node.documentation ?? node.type?.name}>
            {node.kind === 'attribute' ? `@${node.label}` : node.label}
          </span>
          <NodeBadges node={node} />
          {node.present ? (
            <FieldEditor node={node} onChange={(value) => onSetValue(node, value)} />
          ) : (
            <button
              type="button"
              aria-label={`Add ${node.label}`}
              className="rounded-sm border border-dashed border-hairline px-2 text-xs text-fg-subtle hover:bg-surface-hover"
              onClick={() => onEdit({ kind: 'insert-optional', nodeId: node.id })}
            >
              Add
            </button>
          )}
          <button
            type="button"
            aria-label={`Get Data for ${node.label}`}
            className="shrink-0 rounded-sm px-1 text-xs text-fg-subtle hover:bg-surface-hover"
            onClick={() => onGetData(node)}
          >
            Get Data…
          </button>
        </div>
        {hint !== undefined && <p className="ml-42 text-xs text-fg-faint">{hint}</p>}
      </div>
    );
  }

  // A group. A synthetic wrapper (empty label) contributes no header of its own.
  const isOpen = !collapsed.has(node.id);
  const children = node.children.map((child) => (
    <NodeRows {...props} key={child.id} node={child} depth={node.label === '' ? depth : depth + 1} />
  ));
  if (node.label === '') {
    return <>{children}</>;
  }
  return (
    <div style={pad} data-testid="form-group" data-node-id={node.id}>
      <div className="flex items-center gap-2 py-0.5 text-sm">
        <button
          type="button"
          aria-label={isOpen ? `Collapse ${node.label}` : `Expand ${node.label}`}
          aria-expanded={isOpen}
          className="w-3 shrink-0 text-fg-subtle"
          onClick={() => onToggleCollapsed(node.id)}
        >
          {isOpen ? '▾' : '▸'}
        </button>
        <span className="font-medium text-fg-default" title={node.documentation ?? node.type?.name}>
          {node.label}
        </span>
        <NodeBadges node={node} />
        {!node.present && (
          <button
            type="button"
            aria-label={`Add ${node.label}`}
            className="rounded-sm border border-dashed border-hairline px-2 text-xs text-fg-subtle hover:bg-surface-hover"
            onClick={() => onEdit({ kind: 'insert-optional', nodeId: node.id })}
          >
            Add
          </button>
        )}
        {node.truncated === true && <span className="text-xs text-fg-faint italic">Edit in XML</span>}
      </div>
      {isOpen && children}
    </div>
  );
}
