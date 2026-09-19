/**
 * The messages saved under the request, ready to send without retyping them.
 *
 * The list on the left adds, renames, duplicates, deletes and reorders them; the editor on the
 * right edits the selected one in Monaco, in whatever language its text turns out to be (the same
 * detection the timeline's detail uses, so a JSON message is edited as JSON). Every change stages
 * the whole list as one draft of the request — `messages` in a request patch replaces the list,
 * which is how an order is expressed — so the tab carries the unsaved dot and `Mod+S` writes it.
 * Each message has its own Send, live only while the session is open.
 */
import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { prettyFrameText } from '@wirebench/engine/ws';
import { Button } from '../../components/button.js';
import { IconButton } from '../../components/icon-button.js';
import { CodeEditor } from '../../editor/code-editor.js';
import { SAVE_KEYBINDING, SEND_KEYBINDING } from '../../editor/monaco.js';
import type { WsSavedMessageWire } from '../../../shared/wire-types.js';
import { base64Problem } from './ws-format.js';

/** A file-name-safe slug for a message name, unique among `taken`. */
export function uniqueMessageSlug(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'message';
  let slug = base;
  for (let n = 2; taken.includes(slug); n += 1) {
    slug = `${base}-${String(n)}`;
  }
  return slug;
}

/** A name not yet used by any of `messages`: `Message 1`, `Message 2`, … */
function nextName(messages: readonly WsSavedMessageWire[], stem = 'Message'): string {
  const names = new Set(messages.map((message) => message.name));
  let n = messages.length + 1;
  while (names.has(`${stem} ${String(n)}`)) n += 1;
  return `${stem} ${String(n)}`;
}

function newMessage(
  messages: readonly WsSavedMessageWire[],
  name: string,
  from?: Pick<WsSavedMessageWire, 'format' | 'content'>,
): WsSavedMessageWire {
  return {
    id: crypto.randomUUID(),
    name,
    slug: uniqueMessageSlug(
      name,
      messages.map((message) => message.slug),
    ),
    format: from?.format ?? 'text',
    content: from?.content ?? '',
  };
}

export interface WsMessagesTabProps {
  readonly messages: readonly WsSavedMessageWire[];
  readonly selectedId: string | undefined;
  readonly onSelect: (messageId: string | undefined) => void;
  /** Stages the whole list: added, removed, renamed, reordered or edited. */
  readonly onChange: (messages: WsSavedMessageWire[]) => void;
  /** Whether the session is open; every Send is disabled otherwise. */
  readonly open: boolean;
  readonly onSend: (message: WsSavedMessageWire) => void;
  readonly onSave: () => void;
}

/** The Messages tab. */
export function WsMessagesTab({ messages, selectedId, onSelect, onChange, open, onSend, onSave }: WsMessagesTabProps) {
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [renameText, setRenameText] = useState('');
  const selected = messages.find((message) => message.id === selectedId) ?? messages[0];

  const replace = (id: string, patch: Partial<WsSavedMessageWire>): void => {
    onChange(messages.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  };
  const add = (): void => {
    const message = newMessage(messages, nextName(messages));
    onChange([...messages, message]);
    onSelect(message.id);
  };
  const duplicate = (source: WsSavedMessageWire): void => {
    const copy = newMessage(messages, `${source.name} copy`, source);
    const at = messages.indexOf(source);
    onChange([...messages.slice(0, at + 1), copy, ...messages.slice(at + 1)]);
    onSelect(copy.id);
  };
  const remove = (source: WsSavedMessageWire): void => {
    const at = messages.indexOf(source);
    const next = messages.filter((message) => message.id !== source.id);
    onChange(next);
    onSelect(next[Math.min(at, next.length - 1)]?.id);
  };
  const move = (from: number, to: number): void => {
    const next = [...messages];
    const [message] = next.splice(from, 1);
    next.splice(to, 0, message!);
    onChange(next);
  };
  const commitRename = (id: string): void => {
    const name = renameText.trim();
    setRenaming(undefined);
    if (name !== '') replace(id, { name });
  };

  const binaryProblem = selected?.format === 'binary' ? base64Problem(selected.content) : undefined;
  // Monaco's commands are bound once, at mount; they read the latest of these through the ref.
  const latest = useRef({ open, selected, onSend, onSave });
  latest.current = { open, selected, onSend, onSave };
  const language = selected?.format === 'text' ? prettyFrameText(selected.content).language : 'text';

  return (
    <div data-testid="ws-messages" className="flex h-full min-h-0 gap-2 p-3">
      <div className="flex w-56 shrink-0 flex-col gap-2">
        <Button variant="secondary" onClick={add} data-testid="ws-message-add">
          <Plus size={12} aria-hidden="true" />
          Add message
        </Button>
        {messages.length === 0 ? (
          <p className="text-sm text-fg-subtle">No saved messages.</p>
        ) : (
          <ul aria-label="Saved messages" className="flex min-h-0 flex-col gap-0.5 overflow-auto">
            {messages.map((message, index) => {
              const isSelected = message.id === selected?.id;
              return (
                <li
                  key={message.id}
                  data-testid="ws-message-row"
                  className={`flex items-center gap-1 rounded-md px-1 ${isSelected ? 'bg-surface-selected' : ''}`}
                >
                  {renaming === message.id ? (
                    <input
                      aria-label="Message name"
                      autoFocus
                      value={renameText}
                      onChange={(event) => {
                        setRenameText(event.target.value);
                      }}
                      onBlur={() => {
                        commitRename(message.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename(message.id);
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          setRenaming(undefined);
                        }
                      }}
                      className="h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised px-1 text-sm text-fg-default"
                    />
                  ) : (
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        onSelect(message.id);
                      }}
                      className="min-w-0 flex-1 truncate py-1 text-left text-sm text-fg-default"
                    >
                      {message.name}
                    </button>
                  )}
                  <IconButton
                    label={`Send ${message.name}`}
                    disabled={!open}
                    onClick={() => {
                      onSend(message);
                    }}
                  >
                    <Send size={12} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`Rename ${message.name}`}
                    onClick={() => {
                      setRenameText(message.name);
                      setRenaming(message.id);
                    }}
                  >
                    <Pencil size={12} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`Duplicate ${message.name}`}
                    onClick={() => {
                      duplicate(message);
                    }}
                  >
                    <Copy size={12} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`Move ${message.name} up`}
                    disabled={index === 0}
                    onClick={() => {
                      move(index, index - 1);
                    }}
                  >
                    <ArrowUp size={12} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`Move ${message.name} down`}
                    disabled={index === messages.length - 1}
                    onClick={() => {
                      move(index, index + 1);
                    }}
                  >
                    <ArrowDown size={12} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`Delete ${message.name}`}
                    onClick={() => {
                      remove(message);
                    }}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {selected !== undefined && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-fg-muted">
              Format
              <select
                aria-label="Format"
                value={selected.format}
                onChange={(event) => {
                  replace(selected.id, { format: event.target.value === 'binary' ? 'binary' : 'text' });
                }}
                className="h-row rounded-md border border-hairline-strong bg-surface-raised px-2 text-xs text-fg-default"
              >
                <option value="text">Text</option>
                <option value="binary">Binary (base64)</option>
              </select>
            </label>
            {binaryProblem !== undefined && (
              <p role="alert" className="text-xs text-status-danger">
                {binaryProblem}
              </p>
            )}
            <span className="flex-1" />
            <Button
              variant="primary"
              data-testid="ws-message-send"
              disabled={!open || binaryProblem !== undefined}
              title={open ? 'Send this message' : 'Connect to send'}
              onClick={() => {
                onSend(selected);
              }}
            >
              <Send size={12} aria-hidden="true" />
              Send
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded border border-hairline-strong">
            <CodeEditor
              key={selected.id}
              value={selected.content}
              language={language}
              ariaLabel="Saved message"
              onChange={(content) => {
                replace(selected.id, { content });
              }}
              onMount={(editor) => {
                editor.addCommand(SEND_KEYBINDING, () => {
                  const now = latest.current;
                  if (now.open && now.selected !== undefined) now.onSend(now.selected);
                });
                editor.addCommand(SAVE_KEYBINDING, () => {
                  latest.current.onSave();
                });
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
