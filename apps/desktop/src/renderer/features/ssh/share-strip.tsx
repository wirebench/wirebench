import { useState } from 'react';
import type { TerminalShareStateEvent } from '@shared/terminal-share-wire.js';
import { ipc } from '../../state/ipc-client.js';

const BUTTON = 'rounded border border-hairline px-2 py-0.5 text-xs hover:bg-surface-raised';

/**
 * The strip over a shared terminal (#429): who watches, who holds control, each request to approve or
 * decline, the invite link to copy, Take back control and Stop sharing. A viewer is removed from their
 * chip's ×.
 */
export function ShareStrip({ share }: { readonly share: TerminalShareStateEvent }) {
  const [copied, setCopied] = useState(false);
  const { sessionId } = share;
  const holder = share.viewers.find((v) => v.userId === share.control);
  const requests = share.viewers.filter((v) => v.requesting);
  // One chip per person, even with two windows open on the share.
  const people = [...new Map(share.viewers.map((v) => [v.userId, v])).values()];
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-hairline bg-accent-muted px-3 py-1.5 text-xs text-fg-default"
      role="status"
      data-testid="share-strip"
    >
      <span className="font-medium">
        Sharing · {people.length === 0 ? 'nobody watching yet' : `${String(people.length)} watching`}
      </span>
      {people.map((viewer) => (
        <span
          key={viewer.userId}
          className="flex items-center gap-1 rounded-full border border-hairline px-2 py-0.5"
          data-testid={`share-viewer-${viewer.name}`}
        >
          {viewer.name}
          {viewer.control && <span className="text-fg-subtle">(typing)</span>}
          <button
            type="button"
            aria-label={`Remove ${viewer.name}`}
            className="text-fg-subtle hover:text-fg-default"
            onClick={() => {
              void ipc().terminalShare.remove({ sessionId, userId: viewer.userId });
            }}
          >
            ×
          </button>
        </span>
      ))}
      {requests.map((viewer) => (
        <span key={`request-${viewer.userId}`} className="flex items-center gap-1" data-testid="share-request">
          {viewer.name} asks for control
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              void ipc().terminalShare.grant({ sessionId, userId: viewer.userId });
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              void ipc().terminalShare.decline({ sessionId, userId: viewer.userId });
            }}
          >
            Decline
          </button>
        </span>
      ))}
      <span className="flex-1" />
      {holder !== undefined && (
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            void ipc().terminalShare.takeBack({ sessionId });
          }}
        >
          Take back control
        </button>
      )}
      <button
        type="button"
        className={BUTTON}
        onClick={() => {
          void navigator.clipboard.writeText(share.invite).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy invite link'}
      </button>
      <button
        type="button"
        className={BUTTON}
        onClick={() => {
          void ipc().terminalShare.stop({ sessionId });
        }}
      >
        Stop sharing
      </button>
    </div>
  );
}
