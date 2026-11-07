/**
 * Where team management happens (team management in the browser §2): the Team dialog is the browser
 * client's. In a browser tab *Manage team…* opens it in place; in the desktop it opens the server's team
 * page in the default browser, on the right server and team, when the server serves the browser client,
 * and keeps the in-window dialog for a server that does not (ruling 1). The browser tab reads that link
 * once at start-up and opens the dialog on it.
 */
import { isBrowserTab } from '../../lib/capabilities.js';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { ipc } from '../../state/ipc-client.js';
import { useUiStore, type TeamDialogTarget } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';

/** What a server's `GET /meta` lists while it serves the browser client. */
export const BROWSER_CLIENT_CAPABILITY = 'browser-client';

/** The query that opens the dialog: `panel=team`, then `team` or `workspace`. */
const PANEL = 'team';
/** A team or workspace id as the server mints them, with room to spare; anything else is ignored. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** `<server>/?panel=team[&team=…][&workspace=…]`: the browser client's page, with the dialog open. */
export function teamPageUrl(serverUrl: string, target: TeamDialogTarget = {}): string {
  const url = new URL('/', serverUrl);
  url.searchParams.set('panel', PANEL);
  if (target.teamId !== undefined) url.searchParams.set('team', target.teamId);
  if (target.workspaceId !== undefined) url.searchParams.set('workspace', target.workspaceId);
  return url.toString();
}

/** The deep link in `search`, or `undefined` when it is not one; an id that is not an id is dropped. */
export function readTeamDeepLink(search: string): TeamDialogTarget | undefined {
  const params = new URLSearchParams(search);
  if (params.get('panel') !== PANEL) return undefined;
  const id = (name: string): string | undefined => {
    const value = params.get(name);
    return value !== null && ID_PATTERN.test(value) ? value : undefined;
  };
  const teamId = id('team');
  const workspaceId = id('workspace');
  return { ...(teamId !== undefined ? { teamId } : {}), ...(workspaceId !== undefined ? { workspaceId } : {}) };
}

/**
 * Reads the deep link from the address bar once, takes it out (so a reload or a copied address does not
 * open the dialog again), and opens the dialog on it. `true` when there was one.
 */
export function takeTeamDeepLink(location: Pick<Location, 'search' | 'pathname' | 'hash'> = window.location): boolean {
  const target = readTeamDeepLink(location.search);
  if (target === undefined) return false;
  const params = new URLSearchParams(location.search);
  for (const name of ['panel', 'team', 'workspace']) params.delete(name);
  const rest = params.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${location.pathname}${rest === '' ? '' : `?${rest}`}${location.hash}`,
  );
  useUiStore.getState().openTeamDialog(undefined, target);
  return true;
}

/** Same server, whatever the trailing slash or case of the host. */
function sameServer(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

/**
 * The server *Manage team…* is about: the one asked for; else the open workspace's, when it is shared to a
 * signed-in server; else the first signed-in server.
 */
function chooseServer(url: string | undefined): { url: string; target?: TeamDialogTarget } | undefined {
  const signedIn = signedInServers(useAccountStore.getState().servers);
  const share = useWorkspaceStore.getState().workspace?.share;
  const shared = share?.kind === 'server' ? share.server : undefined;
  const chosen =
    url ??
    (shared !== undefined ? signedIn.find((server) => sameServer(server.url, shared.url))?.url : undefined) ??
    signedIn[0]?.url;
  if (chosen === undefined) return undefined;
  return shared !== undefined && sameServer(shared.url, chosen)
    ? { url: chosen, target: { workspaceId: shared.workspaceId } }
    : { url: chosen };
}

/**
 * *Manage team…*. Every entry point calls this. In a browser tab it opens the dialog, as before. In the desktop it
 * asks the server whether it serves the browser client and, if so, opens its team page in the default browser
 * (`window.open` reaches `shell.openExternal` through the window's open handler and its http(s) allow-list);
 * otherwise, or when the server cannot be asked, it opens the dialog in the window (rulings 1 and 4).
 */
export async function manageTeam(url?: string): Promise<void> {
  const ui = useUiStore.getState();
  if (isBrowserTab()) {
    ui.openTeamDialog(url);
    return;
  }
  const chosen = chooseServer(url);
  if (chosen === undefined) {
    ui.openTeamDialog(url);
    return;
  }
  const probe = await ipc().account.probe({ url: chosen.url });
  if (probe.ok && probe.value.meta.capabilities.includes(BROWSER_CLIENT_CAPABILITY)) {
    window.open(teamPageUrl(chosen.url, chosen.target), '_blank', 'noopener');
    return;
  }
  useUiStore.getState().openTeamDialog(chosen.url, chosen.target);
}
