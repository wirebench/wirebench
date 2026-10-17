/**
 * Sharing one's own SSH session (team sessions spec B2, #429). `start` creates the share on the open
 * workspace's server, opens the owner socket and taps the session's output after the masker, the same
 * point the screen and the session log are fed, so a viewer gets nothing the owner's screen did not. Input
 * from the viewer holding control is written to the session as if typed. Closing the session, or the
 * window, ends the share.
 */
import {
  TERMINAL_SHARE_CAPABILITY,
  TERMINAL_SHARE_LIMITS,
  WirebenchError,
  formatTerminalShareInvite,
  type ConnectedWebSocket,
  type TerminalShareEndReason,
  type TerminalShareServerMessage,
} from '@wirebench/engine';
import type { WebContents } from 'electron';
import type {
  TerminalSharePresenceWire,
  TerminalShareStartRequest,
  TerminalShareStartResponse,
  TerminalShareStateEvent,
} from '../../shared/terminal-share-wire.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import type { SessionTap } from '../ssh-service.js';
import { openShareConnection, shareSocketUrl, type ShareConnection } from './connection.js';

export interface ShareTarget {
  readonly url: string;
  readonly workspaceId: string;
}

export interface TerminalShareOwnerDeps {
  readonly client: Pick<ServerClient, 'createTerminalShare' | 'meta'>;
  readonly accounts: TokenSource;
  readonly connect: (wsUrl: string) => ConnectedWebSocket;
  /** The window's open workspace on a server that relays shared terminals, or `undefined`. */
  readonly target: (sender: WebContents) => ShareTarget | undefined;
  readonly ssh: {
    tap(sender: WebContents, sessionId: string, tap: SessionTap): () => void;
    write(sender: WebContents, request: { readonly sessionId: string; readonly data: string }): void;
  };
  readonly emit: (sender: WebContents, state: TerminalShareStateEvent) => void;
}

interface OwnedShare {
  readonly sender: WebContents;
  readonly sessionId: string;
  readonly shareId: string;
  readonly invite: string;
  connection: ShareConnection | undefined;
  untap: (() => void) | undefined;
  viewers: TerminalSharePresenceWire[];
  control: string | null;
  ended: boolean;
}

/** `data` cut into frames the server's message cap takes. */
export function framesOf(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += TERMINAL_SHARE_LIMITS.maxMessageBytes) {
    frames.push(data.subarray(at, at + TERMINAL_SHARE_LIMITS.maxMessageBytes));
  }
  return frames;
}

export class TerminalShareOwner {
  private readonly shares = new Map<string, OwnedShare>();

  constructor(private readonly deps: TerminalShareOwnerDeps) {}

  /** The window's workspace is on a server that relays shared terminals. */
  async available(sender: WebContents): Promise<boolean> {
    const target = this.deps.target(sender);
    if (target === undefined) return false;
    const meta = await this.deps.client.meta(target.url).catch(() => undefined);
    return meta?.capabilities.includes(TERMINAL_SHARE_CAPABILITY) === true;
  }

  /**
   * @throws WirebenchError `terminal-share-unavailable` | `terminal-share-active` | `ssh-session-unknown` | a
   *   server problem (`licensing-feature-required`, …) | `account-signed-out`
   */
  async start(sender: WebContents, request: TerminalShareStartRequest): Promise<TerminalShareStartResponse> {
    const target = this.deps.target(sender);
    if (target === undefined) {
      throw new WirebenchError(
        'terminal-share-unavailable',
        'Sharing needs a workspace shared on a server that relays terminals.',
      );
    }
    if (this.shares.has(request.sessionId)) {
      throw new WirebenchError('terminal-share-active', 'This session is already shared.');
    }
    return withToken(this.deps, target.url, async (origin, token) => {
      const { shareId } = await this.deps.client.createTerminalShare(origin, token, target.workspaceId, {
        hostName: request.hostName,
        cols: request.cols,
        rows: request.rows,
      });
      const share: OwnedShare = {
        sender,
        sessionId: request.sessionId,
        shareId,
        invite: formatTerminalShareInvite({ server: origin, workspaceId: target.workspaceId, shareId }),
        connection: undefined,
        untap: undefined,
        viewers: [],
        control: null,
        ended: false,
      };
      this.shares.set(request.sessionId, share);
      try {
        const { connection } = await openShareConnection(
          this.deps.connect(shareSocketUrl(origin)),
          { type: 'auth', token, workspaceId: target.workspaceId, shareId },
          {
            message: (message) => {
              this.onMessage(share, message);
            },
            binary: () => undefined,
            closed: () => {
              this.finish(share, 'lost');
            },
          },
        );
        share.connection = connection;
        if (share.ended) {
          connection.close();
        } else {
          share.untap = this.deps.ssh.tap(sender, request.sessionId, {
            data: (bytes) => {
              for (const frame of framesOf(bytes)) connection.sendBinary(frame);
            },
            resize: (cols, rows) => {
              connection.send({ type: 'resize', cols, rows });
            },
            end: () => {
              share.untap = undefined;
              connection.send({ type: 'end' });
              this.finish(share, 'ended');
            },
          });
        }
      } catch (error) {
        this.shares.delete(request.sessionId);
        share.connection?.close();
        throw error;
      }
      this.publish(share);
      return { shareId, invite: share.invite };
    });
  }

  /** Idempotent: a session not shared is left as it is. */
  stop(sender: WebContents, sessionId: string): void {
    const share = this.owned(sender, sessionId);
    if (share === undefined) return;
    share.connection?.send({ type: 'end' });
    this.finish(share, 'ended');
  }

  grant(sender: WebContents, sessionId: string, userId: string): void {
    this.owned(sender, sessionId)?.connection?.send({ type: 'grant', userId });
  }

  decline(sender: WebContents, sessionId: string, userId: string): void {
    this.owned(sender, sessionId)?.connection?.send({ type: 'decline', userId });
  }

  remove(sender: WebContents, sessionId: string, userId: string): void {
    this.owned(sender, sessionId)?.connection?.send({ type: 'remove', userId });
  }

  takeBack(sender: WebContents, sessionId: string): void {
    this.owned(sender, sessionId)?.connection?.send({ type: 'take-back' });
  }

  /** The window went away or switched workspace: its shares end. */
  disposeFor(sender: WebContents): void {
    for (const share of [...this.shares.values()]) if (share.sender === sender) this.stop(sender, share.sessionId);
  }

  disposeAll(): void {
    for (const share of [...this.shares.values()]) this.stop(share.sender, share.sessionId);
  }

  private owned(sender: WebContents, sessionId: string): OwnedShare | undefined {
    const share = this.shares.get(sessionId);
    return share?.sender === sender ? share : undefined;
  }

  private onMessage(share: OwnedShare, message: TerminalShareServerMessage): void {
    switch (message.type) {
      case 'presence':
        share.viewers = message.viewers;
        share.control = message.viewers.find((v) => v.control)?.userId ?? null;
        this.publish(share);
        return;
      case 'control':
        share.control = message.userId;
        this.publish(share);
        return;
      case 'input':
        // Only the holder's input reaches here; the server already checked.
        try {
          this.deps.ssh.write(share.sender, { sessionId: share.sessionId, data: message.data });
        } catch {
          // The session closed in flight; its tap ends the share.
        }
        return;
      case 'ended':
        this.finish(share, message.reason);
        return;
      default:
        return;
    }
  }

  private finish(share: OwnedShare, reason: TerminalShareEndReason | 'lost'): void {
    if (share.ended) return;
    share.ended = true;
    share.untap?.();
    share.untap = undefined;
    share.connection?.close();
    if (this.shares.get(share.sessionId) === share) this.shares.delete(share.sessionId);
    this.publish(share, reason);
  }

  private publish(share: OwnedShare, ended?: TerminalShareEndReason | 'lost'): void {
    if (share.sender.isDestroyed()) return;
    this.deps.emit(share.sender, {
      sessionId: share.sessionId,
      shareId: share.shareId,
      invite: share.invite,
      viewers: share.viewers,
      control: share.control,
      ...(ended !== undefined ? { ended } : {}),
    });
  }
}
