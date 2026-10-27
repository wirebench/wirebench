/**
 * Watching a teammate's shared terminal (team sessions spec B2, #429). A pasted invite link names the
 * server, workspace and share; the account signed in to that server joins. Output arrives as it was on
 * the owner's screen, already masked there. While this user holds control, keystrokes go out as `input`.
 */
import type { Caller } from '../host/platform.js';
import {
  WirebenchError,
  parseTerminalShareInvite,
  type ConnectedWebSocket,
  type TerminalShareInvite,
  type TerminalShareServerMessage,
} from '@wirebench/engine';
import type {
  TerminalShareEndReasonWire,
  TerminalShareJoinRequest,
  TerminalShareJoinResponse,
  TerminalSharePresenceWire,
  TerminalSharePreviewResponse,
  TerminalShareViewerStateEvent,
} from '@wirebench/wire/terminal-share-wire';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { openShareConnection, shareSocketUrl, type ShareConnection } from './connection.js';

export interface TerminalShareViewerDeps {
  readonly client: Pick<ServerClient, 'terminalShareInfo'>;
  readonly accounts: TokenSource & { list(): readonly { readonly url: string; readonly userId: string }[] };
  readonly connect: (wsUrl: string) => ConnectedWebSocket;
  readonly emit: {
    data(sender: Caller, event: { readonly viewId: string; readonly data: string }): void;
    state(sender: Caller, event: TerminalShareViewerStateEvent): void;
  };
}

interface View {
  readonly sender: Caller;
  readonly viewId: string;
  readonly self: string | undefined;
  connection: ShareConnection | undefined;
  owner: { userId: string; name: string } | undefined;
  viewers: TerminalSharePresenceWire[];
  control: string | null;
  requesting: boolean;
  declined: boolean;
  cols: number;
  rows: number;
  ended: TerminalShareEndReasonWire | undefined;
}

function inviteOf(link: string): TerminalShareInvite {
  const invite = parseTerminalShareInvite(link);
  if (invite === undefined) {
    throw new WirebenchError('terminal-share-link-invalid', 'That is not a shared terminal link.');
  }
  return invite;
}

export class TerminalShareViewer {
  private readonly views = new Map<string, View>();

  constructor(private readonly deps: TerminalShareViewerDeps) {}

  /** @throws WirebenchError `terminal-share-link-invalid` | `account-signed-out` | `terminal-share-not-found` | … */
  async preview(link: string): Promise<TerminalSharePreviewResponse> {
    const invite = inviteOf(link);
    return withToken(this.deps, invite.server, async (origin, token) => {
      const info = await this.deps.client.terminalShareInfo(origin, token, invite.workspaceId, invite.shareId);
      return { server: origin, ...info };
    });
  }

  /** @throws WirebenchError as {@link preview}, and `terminal-share-forbidden` | `terminal-share-full` */
  async join(sender: Caller, request: TerminalShareJoinRequest): Promise<TerminalShareJoinResponse> {
    const invite = inviteOf(request.link);
    if (this.views.has(request.viewId)) {
      throw new WirebenchError('terminal-share-view-exists', 'That view is already open.');
    }
    return withToken(this.deps, invite.server, async (origin, token) => {
      const self = this.deps.accounts.list().find((account) => account.url === origin)?.userId;
      const view: View = {
        sender,
        viewId: request.viewId,
        self,
        connection: undefined,
        owner: undefined,
        viewers: [],
        control: null,
        requesting: false,
        declined: false,
        cols: 80,
        rows: 24,
        ended: undefined,
      };
      this.views.set(view.viewId, view);
      try {
        const { connection, ready } = await openShareConnection(
          this.deps.connect(shareSocketUrl(origin)),
          { type: 'auth', token, workspaceId: invite.workspaceId, shareId: invite.shareId },
          {
            message: (message) => {
              this.onMessage(view, message);
            },
            binary: (data) => {
              if (!sender.isClosed())
                this.deps.emit.data(sender, { viewId: view.viewId, data: data.toString('base64') });
            },
            closed: () => {
              this.finish(view, 'lost');
            },
          },
        );
        if (ready.type !== 'viewer-ready') {
          connection.close();
          throw new WirebenchError('terminal-share-own', 'This is your own shared terminal.');
        }
        view.connection = connection;
        view.cols = ready.cols;
        view.rows = ready.rows;
        this.publish(view);
        return {
          viewId: view.viewId,
          hostName: ready.hostName,
          ownerName: ready.ownerName,
          cols: ready.cols,
          rows: ready.rows,
        };
      } catch (error) {
        this.views.delete(view.viewId);
        throw error;
      }
    });
  }

  leave(sender: Caller, viewId: string): void {
    const view = this.owned(sender, viewId);
    if (view === undefined) return;
    view.connection?.close();
    this.views.delete(viewId);
  }

  /** Typed keys: sent only while this user holds control, else dropped here. */
  input(sender: Caller, viewId: string, data: string): void {
    const view = this.owned(sender, viewId);
    if (view?.connection === undefined || view.self === undefined || view.control !== view.self) return;
    view.connection.send({ type: 'input', data });
  }

  requestControl(sender: Caller, viewId: string): void {
    const view = this.owned(sender, viewId);
    if (view?.connection === undefined) return;
    view.declined = false;
    view.connection.send({ type: 'request-control' });
  }

  release(sender: Caller, viewId: string): void {
    this.owned(sender, viewId)?.connection?.send({ type: 'release' });
  }

  disposeFor(sender: Caller): void {
    for (const view of [...this.views.values()]) if (view.sender === sender) this.leave(sender, view.viewId);
  }

  disposeAll(): void {
    for (const view of [...this.views.values()]) this.leave(view.sender, view.viewId);
  }

  private owned(sender: Caller, viewId: string): View | undefined {
    const view = this.views.get(viewId);
    return view?.sender === sender ? view : undefined;
  }

  private onMessage(view: View, message: TerminalShareServerMessage): void {
    switch (message.type) {
      case 'presence': {
        view.owner = message.owner;
        view.viewers = message.viewers;
        const mine = message.viewers.filter((v) => v.userId === view.self);
        view.requesting = mine.some((v) => v.requesting);
        break;
      }
      case 'control':
        view.control = message.userId;
        if (message.userId === view.self) view.requesting = false;
        break;
      case 'resize':
        view.cols = message.cols;
        view.rows = message.rows;
        break;
      case 'declined':
        view.declined = true;
        view.requesting = false;
        break;
      case 'ended':
        this.end(view, message.reason);
        break;
      default:
        return;
    }
    this.publish(view);
  }

  private finish(view: View, reason: TerminalShareEndReasonWire): void {
    if (this.views.get(view.viewId) !== view) return;
    this.views.delete(view.viewId);
    this.end(view, view.ended ?? reason);
    this.publish(view);
  }

  /** An ended share has nobody watching it and nobody typing into it. */
  private end(view: View, reason: TerminalShareEndReasonWire): void {
    view.ended = reason;
    view.viewers = [];
    view.control = null;
    view.requesting = false;
    view.declined = false;
  }

  private publish(view: View): void {
    if (view.sender.isClosed()) return;
    this.deps.emit.state(view.sender, {
      viewId: view.viewId,
      ...(view.owner !== undefined ? { owner: view.owner } : {}),
      viewers: view.viewers,
      control: view.control,
      ...(view.self !== undefined ? { self: view.self } : {}),
      requesting: view.requesting,
      ...(view.declined ? { declined: true } : {}),
      cols: view.cols,
      rows: view.rows,
      ...(view.ended !== undefined ? { ended: view.ended } : {}),
    });
  }
}
