/**
 * The browser client's address: where a tab is, so a reload, a bookmark or Back lands there again.
 *
 *   /                                         the workspace list
 *   /workspaces/<workspace>                   a workspace, on its Start tab
 *   /workspaces/<workspace>/<kind>/<id>       a workspace, on a tab that names an entity (a request, an environment…)
 *
 * The query carries the rest of the view, each only when it differs from the default, so the list stays at `/`:
 * `view` (the sidebar area), `sidebar=off`, `console=<tab>` (open, on that tab), `code=on`, `env=off|projects`
 * (beside an environment), `host=on` (beside the SSH hosts), and Settings: `panel=app|user|team` with `page`, and
 * `team` for Team settings. Any other parameter (the desktop's `add=passkey`) is kept as it is.
 *
 * `<workspace>` is the team workspace's id for a server workspace, so the same link opens the same workspace for a
 * teammate; the local id for any other.
 */

/** A tab the address names: its kind and the id of its entity. */
export interface AddressTab {
  readonly kind: string;
  readonly id: string;
}

export interface SettingsAddress {
  readonly area: 'app' | 'user' | 'team';
  readonly page?: string;
  /** Team settings only: the team shown. */
  readonly team?: string;
}

export interface Address {
  readonly workspace?: string;
  readonly tab?: AddressTab;
  /** The sidebar area; absent means the default one. */
  readonly view?: string;
  readonly sidebarHidden?: boolean;
  /** The console's tab while it is open. */
  readonly console?: string;
  readonly code?: boolean;
  /** Beside an open environment: its details are hidden, or the Projects panel shows instead. */
  readonly environmentPanel?: 'off' | 'projects';
  readonly hostDetails?: boolean;
  readonly settings?: SettingsAddress;
}

/** The query parameters the address owns; every other one is carried along untouched. */
const OWN_PARAMS = ['view', 'sidebar', 'console', 'code', 'env', 'host', 'panel', 'page', 'team', 'workspace'];
/** An id or kind as the app mints them, with room to spare; anything else in an address is ignored. */
const SEGMENT = /^[A-Za-z0-9._:-]{1,128}$/;
/** A page, area or console tab id. */
const NAME = /^[a-z][a-z0-9-]{0,47}$/;

function segment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return SEGMENT.test(decoded) ? decoded : undefined;
}

function name(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key);
  return value !== null && NAME.test(value) ? value : undefined;
}

/** Reads an address; whatever does not fit its shape is left out rather than refused. */
export function parseAddress(pathname: string, search: string): Address {
  const params = new URLSearchParams(search);
  const parts = pathname.split('/').filter((part) => part !== '');
  const workspace = parts[0] === 'workspaces' ? segment(parts[1]) : undefined;
  const kind = workspace === undefined ? undefined : segment(parts[2]);
  const id = kind === undefined ? undefined : segment(parts[3]);
  const view = name(params, 'view');
  const consoleTab = name(params, 'console');
  const env = params.get('env');
  const panel = params.get('panel');
  const page = name(params, 'page');
  const team = segment(params.get('team') ?? undefined);
  let settings: SettingsAddress | undefined;
  if (panel === 'app' || panel === 'user' || panel === 'team') {
    settings = {
      area: panel,
      ...(page !== undefined ? { page } : {}),
      ...(panel === 'team' && team !== undefined ? { team } : {}),
    };
  }
  return {
    ...(workspace !== undefined ? { workspace } : {}),
    ...(kind !== undefined && id !== undefined ? { tab: { kind, id } } : {}),
    ...(view !== undefined ? { view } : {}),
    ...(params.get('sidebar') === 'off' ? { sidebarHidden: true } : {}),
    ...(consoleTab !== undefined ? { console: consoleTab } : {}),
    ...(params.get('code') === 'on' ? { code: true } : {}),
    ...(env === 'off' || env === 'projects' ? { environmentPanel: env } : {}),
    ...(params.get('host') === 'on' ? { hostDetails: true } : {}),
    ...(settings !== undefined ? { settings } : {}),
  };
}

/** The path and query of `address`, keeping every parameter of `search` the address does not own. */
export function formatAddress(address: Address, search = ''): string {
  let path = '/';
  if (address.workspace !== undefined) {
    path = `/workspaces/${encodeURIComponent(address.workspace)}`;
    if (address.tab !== undefined) {
      path += `/${encodeURIComponent(address.tab.kind)}/${encodeURIComponent(address.tab.id)}`;
    }
  }
  const params = new URLSearchParams();
  const settings = address.settings;
  if (settings !== undefined) {
    params.append('panel', settings.area);
    if (settings.team !== undefined) params.append('team', settings.team);
    if (settings.page !== undefined) params.append('page', settings.page);
  }
  if (address.view !== undefined) params.append('view', address.view);
  if (address.sidebarHidden === true) params.append('sidebar', 'off');
  if (address.console !== undefined) params.append('console', address.console);
  if (address.code === true) params.append('code', 'on');
  if (address.environmentPanel !== undefined) params.append('env', address.environmentPanel);
  if (address.hostDetails === true) params.append('host', 'on');
  for (const [key, value] of new URLSearchParams(search)) {
    // `add=passkey` asks User settings for a passkey prompt: it goes once User settings is left.
    if (key === 'add' && settings?.area !== 'user') continue;
    if (!OWN_PARAMS.includes(key)) params.append(key, value);
  }
  const query = params.toString();
  return query === '' ? path : `${path}?${query}`;
}

/**
 * Whether going from `from` to `to` is a move to another place — a workspace, a tab, a sidebar area or a settings
 * page — which gets its own history entry, as following a link would. Showing or hiding a panel is not: it replaces
 * the entry, so Back does not step through every toggle. Nor is a settings page settling on the page (or team) it
 * shows, after an address that named none.
 */
export function isNewPlace(from: Address, to: Address): boolean {
  const differs = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && a !== b;
  return (
    from.workspace !== to.workspace ||
    from.tab?.kind !== to.tab?.kind ||
    from.tab?.id !== to.tab?.id ||
    from.view !== to.view ||
    from.settings?.area !== to.settings?.area ||
    differs(from.settings?.page, to.settings?.page) ||
    differs(from.settings?.team, to.settings?.team)
  );
}
