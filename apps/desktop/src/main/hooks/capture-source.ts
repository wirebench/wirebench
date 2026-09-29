/**
 * The desktop's capture source (callback-assertion spec §5): the open workspace's server, read with
 * the signed-in account's token through `withToken`, which marks the account signed out when the
 * server refuses it. The paging, the order and the decoding are the engine's (`captureSourceOver`).
 *
 * A `CaptureSource` takes no signal, so each read has its own deadline, the CLI's 10 s: a hung read
 * must not hold a callback's wait, or a cancel, past it. The client's own timeout (15 s, 120 s for a
 * capture's detail) is longer, so the read is abandoned here rather than there.
 */
import { WirebenchError, captureSourceOver, unavailableCaptureSource } from '@wirebench/engine';
import type { CaptureSource } from '@wirebench/engine';
import type { WorkspaceWire } from '../../shared/wire-types.js';
import { normalizeServerUrl, type ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';

export const UNLINKED_WORKSPACE_MESSAGE = 'this workspace is not linked to a Wirebench Server';

/** Each read's own deadline: the same as the CLI's. */
export const CAPTURE_READ_TIMEOUT_MS = 10_000;

export interface LinkedServer {
  readonly url: string;
  readonly workspaceId: string;
}

export interface DesktopCaptureDeps {
  readonly client: Pick<ServerClient, 'listHooks' | 'listCaptures' | 'getCapture'>;
  readonly accounts: TokenSource;
}

/** The server a workspace is shared on, or `undefined` for a local, folder or git workspace. */
export function linkedServerOf(workspace: WorkspaceWire | null | undefined): LinkedServer | undefined {
  const share = workspace?.share;
  if (share?.kind !== 'server' || share.server === undefined) return undefined;
  return { url: share.server.url, workspaceId: share.server.workspaceId };
}

/** `read`, or `server-unreachable` once `CAPTURE_READ_TIMEOUT_MS` passes without an answer. */
function withDeadline<T>(url: string, read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new WirebenchError('server-unreachable', `Could not reach ${normalizeServerUrl(url)}`));
    }, CAPTURE_READ_TIMEOUT_MS);
  });
  return Promise.race([read, late]).finally(() => {
    clearTimeout(timer);
  });
}

export function desktopCaptureSource(deps: DesktopCaptureDeps, server: LinkedServer | undefined): CaptureSource {
  if (server === undefined) return unavailableCaptureSource(UNLINKED_WORKSPACE_MESSAGE);
  const { url, workspaceId } = server;
  const read = <T>(call: (origin: string, token: string) => Promise<T>): Promise<T> =>
    withDeadline(url, withToken(deps, url, call));
  return captureSourceOver({
    hooks: () => read((origin, token) => deps.client.listHooks(origin, token, workspaceId)),
    captures: (hookId, page) =>
      read((origin, token) => deps.client.listCaptures(origin, token, workspaceId, hookId, page)),
    capture: (hookId, captureId) =>
      read((origin, token) => deps.client.getCapture(origin, token, workspaceId, hookId, captureId)),
  });
}
