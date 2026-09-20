/**
 * The subprotocols the handshake asks for, in order of preference — the server picks one, and the
 * order is how the request says which it would rather have. A token is plain visible ASCII with no
 * separators; one with a space, a comma or a character outside ASCII would split or corrupt the
 * `Sec-WebSocket-Protocol` header, so it is refused inline rather than sent.
 */
import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { IconButton } from '../../components/icon-button.js';
import type { WsRequestPatchWire } from '../../../shared/wire-types.js';
import { subprotocolProblem } from './ws-format.js';

export interface WsSubprotocolsTabProps {
  readonly subprotocols: readonly string[];
  readonly onChange: (patch: WsRequestPatchWire) => void;
}

/** The Subprotocols tab. */
export function WsSubprotocolsTab({ subprotocols, onChange }: WsSubprotocolsTabProps) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const set = (next: readonly string[]): void => {
    onChange({ subprotocols: [...next] });
  };
  const add = (): void => {
    const token = draft;
    const refused = subprotocolProblem(token) ?? (subprotocols.includes(token) ? 'Already in the list.' : undefined);
    setProblem(refused);
    if (refused !== undefined) return;
    set([...subprotocols, token]);
    setDraft('');
  };
  const move = (from: number, to: number): void => {
    const next = [...subprotocols];
    const [token] = next.splice(from, 1);
    next.splice(to, 0, token!);
    set(next);
  };

  return (
    <div data-testid="ws-subprotocols" className="flex flex-col gap-2 overflow-auto p-3">
      <p className="text-xs text-fg-subtle">Asked for in this order; the server chooses one.</p>
      {subprotocols.length === 0 ? (
        <p className="text-sm text-fg-subtle">No subprotocols.</p>
      ) : (
        <ol aria-label="Subprotocols" className="flex flex-col gap-1">
          {subprotocols.map((token, index) => (
            <li key={token} data-testid="ws-subprotocol" className="flex items-center gap-1 font-mono text-sm">
              <span className="min-w-0 flex-1 truncate text-fg-default">{token}</span>
              <IconButton
                label={`Move ${token} up`}
                disabled={index === 0}
                onClick={() => {
                  move(index, index - 1);
                }}
              >
                <ArrowUp size={12} aria-hidden="true" />
              </IconButton>
              <IconButton
                label={`Move ${token} down`}
                disabled={index === subprotocols.length - 1}
                onClick={() => {
                  move(index, index + 1);
                }}
              >
                <ArrowDown size={12} aria-hidden="true" />
              </IconButton>
              <IconButton
                label={`Remove ${token}`}
                onClick={() => {
                  set(subprotocols.filter((_, at) => at !== index));
                }}
              >
                <X size={12} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-2">
        <input
          aria-label="New subprotocol"
          aria-invalid={problem !== undefined}
          aria-describedby={problem !== undefined ? 'ws-subprotocol-problem' : undefined}
          spellCheck={false}
          value={draft}
          placeholder="chat.v2"
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          className="h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
        />
        <Button variant="secondary" onClick={add}>
          <Plus size={12} aria-hidden="true" />
          Add
        </Button>
      </div>
      {problem !== undefined && (
        <p id="ws-subprotocol-problem" role="alert" className="text-xs text-status-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
