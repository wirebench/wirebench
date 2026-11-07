/**
 * Where team management happens (team management in the browser §2, settings split spec §5): Team settings is the
 * browser client's. In a browser tab *Manage team…* opens it in place; in the desktop it opens the server's team
 * page in the default browser, on the right server and team, when the server serves the browser client, and keeps
 * the in-window dialog for a server that does not (ruling 1). The browser tab reads that link at start-up and opens
 * Team settings on it.
 */
import { isBrowserTab } from '../../lib/capabilities.js';
import { activeAccount, useAccountStore } from '../../state/account.js';
import { ipc } from '../../state/ipc-client.js';
import { useUiStore, type TeamDialogTarget } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { isTeamSettingsPage, type TeamSettingsPageId } from './team-settings-model.js';

/** What a server's `GET /meta` lists while it serves the browser client. */
export const BROWSER_CLIENT_CAPABILITY = 'browser-client';

/** The query that opens the dialog: `panel=team`, then `team` or `workspace`. */
const PANEL = 'team';
/** A team or workspace id as the server mints them, with room to spare; anything else is ignored. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** A page id's shape; whether it is a page the caller may see is the menu's question, not the address's. */
const PAGE_PATTERN = /^[a-z-]{1,32}$/;
/** The parameters the address owns (settings split spec §5); every other one is left alone. */
const OWN_PARAMS = ['panel', 'team', 'workspace', 'page'] as const;

/** Where a Team settings address points: a team (else a workspace's team) and a page. */
export interface TeamSettingsAddress {
  readonly teamId?: string;
  readonly workspaceId?: string;
  readonly page?: string;
}

/** `<server>/?panel=team[&team=…][&workspace=…][&page=…]`: the browser client's team page. */
export function teamPageUrl(
  serverUrl: string,
  target: TeamDialogTarget & { readonly page?: TeamSettingsPageId } = {},
): string {
  const url = new URL('/', serverUrl);
  url.searchParams.set('panel', PANEL);
  if (target.teamId !== undefined) url.searchParams.set('team', target.teamId);
  if (target.workspaceId !== undefined) url.searchParams.set('workspace', target.workspaceId);
  if (target.page !== undefined) url.searchParams.set('page', target.page);
  return url.toString();
}

/** `panel=team[&team][&workspace][&page]`; an id outside ID_PATTERN or a page outside /^[a-z-]{1,32}$/ is dropped. */
export function readTeamDeepLink(search: string): TeamSettingsAddress | undefined {
  const params = new URLSearchParams(search);
  if (params.get('panel') !== PANEL) return undefined;
  const read = (name: string, pattern: RegExp): string | undefined => {
    const value = params.get(name);
    return value !== null && pattern.test(value) ? value : undefined;
  };
  const teamId = read('team', ID_PATTERN);
  const workspaceId = read('workspace', ID_PATTERN);
  const page = read('page', PAGE_PATTERN);
  return {
    ...(teamId !== undefined ? { teamId } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(page !== undefined ? { page } : {}),
  };
}

function withoutOwn(search: string): URLSearchParams {
  const params = new URLSearchParams(search);
  for (const name of OWN_PARAMS) params.delete(name);
  return params;
}

/**
 * `search` with panel, team and page set (other parameters kept, workspace dropped), in that order. The workspace
 * only picks a team on the way in; once the page knows its team, the team id says it.
 */
export function teamSettingsSearch(
  search: string,
  address: { readonly teamId: string | undefined; readonly page: TeamSettingsPageId },
): string {
  const params = withoutOwn(search);
  params.append('panel', PANEL);
  if (address.teamId !== undefined) params.append('team', address.teamId);
  params.append('page', address.page);
  return `?${params.toString()}`;
}

/** `search` without panel, team, workspace and page. */
export function withoutTeamSettings(search: string): string {
  const rest = withoutOwn(search).toString();
  return rest === '' ? '' : `?${rest}`;
}

/**
 * Reads the deep link from the address bar and opens Team settings on it. The address stays as it is (ruling 17):
 * Team settings keeps it current, so a reload or a bookmark lands on the same page. `true` when there was one.
 */
export function openTeamDeepLink(location: Pick<Location, 'search'> = window.location): boolean {
  const address = readTeamDeepLink(location.search);
  if (address === undefined) return false;
  const { teamId, workspaceId, page } = address;
  useUiStore.getState().openTeamSettings({
    ...(teamId !== undefined ? { teamId } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    // A page that is not one is left out, so the page falls back to People.
    ...(page !== undefined && isTeamSettingsPage(page) ? { page } : {}),
  });
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
 * The server *Manage team…* is about: the one asked for, else the active account's (switch accounts spec §4). The
 * open workspace's team is carried when it is shared to that server.
 */
function chooseServer(url: string | undefined): { url: string; target?: TeamDialogTarget } | undefined {
  const { servers, active } = useAccountStore.getState();
  const share = useWorkspaceStore.getState().workspace?.share;
  const shared = share?.kind === 'server' ? share.server : undefined;
  const chosen = url ?? activeAccount(servers, active)?.url;
  if (chosen === undefined) return undefined;
  return shared !== undefined && sameServer(shared.url, chosen)
    ? { url: chosen, target: { workspaceId: shared.workspaceId } }
    : { url: chosen };
}

/**
 * *Manage team…*. Every entry point calls this. In a browser tab it opens Team settings. In the desktop it
 * asks the server whether it serves the browser client and, if so, opens its team page in the default browser
 * (`window.open` reaches `shell.openExternal` through the window's open handler and its http(s) allow-list);
 * otherwise, or when the server cannot be asked, it opens the dialog in the window (rulings 1 and 4).
 */
export async function manageTeam(url?: string): Promise<void> {
  const ui = useUiStore.getState();
  if (isBrowserTab()) {
    ui.openTeamSettings(url === undefined ? {} : { url });
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
