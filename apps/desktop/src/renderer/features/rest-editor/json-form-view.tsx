/**
 * A raw JSON body shown as a form over its operation's schema.
 *
 * The view holds no copy of the body: it parses the text it is given on every render and builds the
 * tree from that, so it can never drift from what the text editor shows. It writes only when the user
 * edits something — each edit goes through the engine's `applyJsonFormEdit` and comes back as
 * `JSON.stringify(value, null, 2)` — so flipping to Form and back leaves the text byte-identical.
 *
 * Every control is labelled by its property path (`owner.tags[0]`), which is what a screen reader
 * announces and what a test finds it by.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyJsonFormEdit,
  buildJsonForm,
  type JsonFormEdit,
  type JsonFormNode,
  type JsonSchema,
  type JsonValue,
} from '@wirebench/engine/rest';
import { Button } from '../../components/button.js';

export interface JsonFormViewProps {
  /** The body text as the text editor holds it. */
  readonly text: string;
  readonly schema: JsonSchema;
  /** The new body text after an edit. */
  readonly onChange: (text: string) => void;
  /** Goes back to the text editor; offered when the text does not parse. */
  readonly onShowText?: () => void;
  readonly readOnly?: boolean;
}

/** The label the root takes, since it has no property name of its own. */
const ROOT_PATH = 'body';

type Parsed = { readonly ok: true; readonly value: JsonValue | undefined } | { readonly ok: false };

function parse(text: string): Parsed {
  // An empty body is "no value yet", which the form can fill — not a syntax error.
  if (text.trim() === '') {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch {
    return { ok: false };
  }
}

const CONTROL =
  'min-w-0 flex-1 rounded-sm border border-hairline bg-surface-base px-1 py-0.5 text-sm text-fg-default disabled:opacity-60';

/** The JSON form. */
export function JsonFormView({ text, schema, onChange, onShowText, readOnly = false }: JsonFormViewProps) {
  const parsed = useMemo(() => parse(text), [text]);
  const root = useMemo(() => (parsed.ok ? buildJsonForm(schema, parsed.value) : undefined), [parsed, schema]);

  if (!parsed.ok || root === undefined) {
    return (
      <div data-testid="json-form-view" className="flex flex-col items-start gap-2 p-1 text-sm">
        <p className="text-fg-muted">The body is not valid JSON</p>
        {onShowText !== undefined && (
          <Button variant="secondary" onClick={onShowText}>
            Back to Text
          </Button>
        )}
      </div>
    );
  }

  const edit = (change: JsonFormEdit): void => {
    onChange(JSON.stringify(applyJsonFormEdit(schema, parsed.value, change), null, 2));
  };

  return (
    <div data-testid="json-form-view" className="min-h-0 flex-1 overflow-auto p-1">
      <NodeView node={root} path="" parent="root" edit={edit} readOnly={readOnly} />
    </div>
  );
}

type ParentKind = 'root' | 'object' | 'array' | 'choice';

interface NodeViewProps {
  readonly node: JsonFormNode;
  /** The property path of this node, `''` for the root. */
  readonly path: string;
  readonly parent: ParentKind;
  readonly edit: (change: JsonFormEdit) => void;
  readonly readOnly: boolean;
}

function childPath(path: string, node: JsonFormNode, child: JsonFormNode): string {
  if (node.kind === 'choice') {
    return path;
  }
  if (node.kind === 'array') {
    return `${path === '' ? ROOT_PATH : path}[${child.name}]`;
  }
  return path === '' ? child.name : `${path}.${child.name}`;
}

/** One node: a row with its label and control, then its children indented below it. */
function NodeView({ node, path, parent, edit, readOnly }: NodeViewProps) {
  const label = path === '' ? ROOT_PATH : path;
  const disabled = readOnly || node.readOnly === true;

  // A choice's object branch is the same place in the value: its properties render as the choice's
  // body. A scalar or array branch falls through to an ordinary row with its own control.
  if (parent === 'choice' && node.kind === 'object') {
    return <Children node={node} path={path} edit={edit} readOnly={readOnly} />;
  }

  if (!node.present) {
    return (
      <Row node={node} label={label}>
        <Button
          variant="secondary"
          aria-label={`Add ${label}`}
          disabled={disabled}
          onClick={() => {
            edit({ kind: 'insert-optional', id: node.id });
          }}
        >
          Add
        </Button>
      </Row>
    );
  }

  // Array items can always go; an object property only when the schema does not require it.
  const removable = parent === 'array' || (parent === 'object' && !node.required);
  const remove = removable ? (
    <Button
      variant="ghost"
      aria-label={`Remove ${label}`}
      disabled={disabled}
      onClick={() => {
        edit({ kind: 'remove', id: node.id });
      }}
    >
      Remove
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col">
      <Row node={node} label={label}>
        {node.kind === 'field' && <FieldControl node={node} label={label} edit={edit} disabled={disabled} />}
        {node.kind === 'any' && <AnyControl node={node} label={label} edit={edit} disabled={disabled} />}
        {node.kind === 'choice' && (
          <select
            aria-label={`${label} variant`}
            disabled={disabled}
            value={node.chosen ?? 0}
            className={CONTROL}
            onChange={(event) => {
              edit({ kind: 'select-choice', id: node.id, index: Number(event.target.value) });
            }}
          >
            {(node.choices ?? []).map((choice, index) => (
              <option key={index} value={index}>
                {choice}
              </option>
            ))}
          </select>
        )}
        {node.kind === 'array' && (
          <Button
            variant="secondary"
            aria-label={`Add item to ${label}`}
            disabled={disabled}
            onClick={() => {
              edit({ kind: 'add-item', id: node.id });
            }}
          >
            Add item
          </Button>
        )}
        {remove}
      </Row>
      <Children node={node} path={path} edit={edit} readOnly={readOnly} />
    </div>
  );
}

function Children({ node, path, edit, readOnly }: Omit<NodeViewProps, 'parent'>) {
  if (node.children.length === 0) {
    return null;
  }
  const parent: ParentKind = node.kind === 'choice' ? 'choice' : node.kind === 'array' ? 'array' : 'object';
  const nested = (
    <>
      {node.children.map((child, index) => (
        // A choice and its branch share an id, so the kind (and index) keep keys distinct.
        <NodeView
          key={`${child.kind}:${child.id}:${index}`}
          node={child}
          path={childPath(path, node, child)}
          parent={parent}
          edit={edit}
          readOnly={readOnly}
        />
      ))}
    </>
  );
  return parent === 'choice' ? (
    nested
  ) : (
    <div className="ml-4 flex flex-col border-l border-hairline pl-2">{nested}</div>
  );
}

/** A label, the node's badges, and whatever controls the node has. */
function Row({
  node,
  label,
  children,
}: {
  readonly node: JsonFormNode;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5" title={node.description}>
      <span className="w-40 shrink-0 truncate font-mono text-xs text-fg-default">
        {node.label === '' ? label : node.label}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-xs">
        {node.required ? (
          <span className="text-status-warning" title="Required">
            *
          </span>
        ) : (
          <span className="text-fg-faint" title="Optional">
            opt
          </span>
        )}
        {node.deprecated === true && <span className="text-fg-faint">deprecated</span>}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
    </div>
  );
}

interface ControlProps {
  readonly node: JsonFormNode;
  readonly label: string;
  readonly edit: (change: JsonFormEdit) => void;
  readonly disabled: boolean;
}

/** The editor for one scalar. */
function FieldControl({ node, label, edit, disabled }: ControlProps) {
  const set = (value: JsonValue): void => {
    edit({ kind: 'set-value', id: node.id, value });
  };

  if (node.enum !== undefined && node.enum.length > 0) {
    const members = node.enum;
    const current = members.findIndex((member) => JSON.stringify(member) === JSON.stringify(node.value));
    return (
      <select
        aria-label={label}
        disabled={disabled}
        value={current === -1 ? '' : String(current)}
        className={CONTROL}
        onChange={(event) => {
          const member = members[Number(event.target.value)];
          if (member !== undefined) {
            set(member);
          }
        }}
      >
        {current === -1 && <option value="">{JSON.stringify(node.value ?? null)}</option>}
        {members.map((member, index) => (
          <option key={index} value={String(index)}>
            {typeof member === 'string' ? member : JSON.stringify(member)}
          </option>
        ))}
      </select>
    );
  }

  switch (node.valueType) {
    case 'boolean':
      return (
        <input
          type="checkbox"
          aria-label={label}
          disabled={disabled}
          checked={node.value === true}
          className="h-4 w-4 accent-accent"
          onChange={(event) => {
            set(event.target.checked);
          }}
        />
      );
    case 'null':
      return <span className="font-mono text-xs text-fg-subtle">null</span>;
    case 'number':
    case 'integer':
      return <NumberControl node={node} label={label} edit={edit} disabled={disabled} />;
    default:
      return (
        <input
          type="text"
          aria-label={label}
          disabled={disabled}
          value={typeof node.value === 'string' ? node.value : JSON.stringify(node.value ?? '')}
          placeholder={node.format}
          className={CONTROL}
          onChange={(event) => {
            set(event.target.value);
          }}
        />
      );
  }
}

/**
 * A number keeps its own draft: `1.` or `-` is on the way to a number but is not one yet, so only a
 * draft that parses is written, and the draft follows the value when it changes from elsewhere.
 */
function NumberControl({ node, label, edit, disabled }: ControlProps) {
  const external = typeof node.value === 'number' ? String(node.value) : '';
  const [draft, setDraft] = useState(external);
  useEffect(() => {
    setDraft((current) => (Number(current) === Number(external) && current.trim() !== '' ? current : external));
  }, [external]);
  return (
    <input
      type="number"
      aria-label={label}
      disabled={disabled}
      value={draft}
      {...(node.valueType === 'integer' ? { step: 1 } : {})}
      className={CONTROL}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        const value = Number(next);
        if (next.trim() !== '' && Number.isFinite(value)) {
          edit({ kind: 'set-value', id: node.id, value });
        }
      }}
    />
  );
}

/** A value the schema does not describe (or the tree stopped at) is edited as raw JSON, written on blur. */
function AnyControl({ node, label, edit, disabled }: ControlProps) {
  const external = node.value === undefined ? '' : JSON.stringify(node.value);
  const [draft, setDraft] = useState(external);
  useEffect(() => {
    setDraft(external);
  }, [external]);
  return (
    <input
      type="text"
      aria-label={label}
      disabled={disabled}
      value={draft}
      className={`${CONTROL} font-mono`}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={() => {
        if (draft === external) {
          return;
        }
        try {
          edit({ kind: 'set-value', id: node.id, value: JSON.parse(draft) as JsonValue });
        } catch {
          setDraft(external);
        }
      }}
    />
  );
}
