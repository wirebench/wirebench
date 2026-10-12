/**
 * The hosts of `hosts.yaml` as cards (or rows), one foldable section per group (subgroups follow
 * their parent, named by their whole path), hosts outside any group first. A filter or tag narrows
 * the cards to what matches, opening folded sections and dropping empty ones. Click selects, arrows
 * move, double-click or Enter connects; clicking the picked card again hides its details. The ⋯
 * menu shows on hover, right-click has the same items.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ChevronRight, Plus, Server } from 'lucide-react';
import { Button } from '../../components/button.js';
import type { GroupEntryWire, HostEntryWire, HostsFileWire, ResolvedHostWire } from '../../../shared/ssh-wire.js';
import { openTerminalFor } from './connect.js';
import { GroupMenu, HostActionsButton, HostMenu } from './host-menus.js';
import { TOP_LEVEL, type HostsLayout, type HostsPrefs, type HostsSort } from './hosts-prefs.js';
import { flattenGroups, osKeyOf, useHostsStore, type HostSession } from './hosts-store.js';
import { OsIcon, osOf, osTextOf } from './os-icon.js';
import { sessionStatus } from './session-status.js';

interface Section {
  /** Absent for the hosts outside any group. */
  readonly group?: GroupEntryWire;
  /** The group's names from the top, joined: `Production / EU`. */
  readonly title: string;
  readonly hosts: readonly HostEntryWire[];
}

/**
 * The file's hosts in sections: the top level first, then every group in tree order. With `only`,
 * just that group and the groups inside it.
 */
function sectionsOf(file: HostsFileWire, only?: string): Section[] {
  const out: Section[] = only === undefined ? [{ title: 'Ungrouped', hosts: file.hosts }] : [];
  const walk = (groups: readonly GroupEntryWire[], prefix: string, inside: boolean): void => {
    for (const group of groups) {
      const title = prefix === '' ? group.name : `${prefix} / ${group.name}`;
      const keep = inside || only === undefined || group.id === only;
      if (keep) out.push({ group, title, hosts: group.hosts });
      walk(group.groups, title, keep);
    }
  };
  walk(file.groups, '', false);
  return out;
}

const live = (session: HostSession | undefined): boolean =>
  session?.state === 'open' || session?.state === 'connecting';

function sortHosts(
  hosts: readonly HostEntryWire[],
  sort: HostsSort,
  sessions: Readonly<Record<string, HostSession>>,
): HostEntryWire[] {
  const byName = (a: HostEntryWire, b: HostEntryWire): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  return [...hosts].sort((a, b) => {
    if (sort === 'address') return a.address.localeCompare(b.address, undefined, { numeric: true }) || byName(a, b);
    if (sort === 'connected') return Number(live(sessions[b.id])) - Number(live(sessions[a.id])) || byName(a, b);
    return byName(a, b);
  });
}

/** `user@address:port`, leaving out what the host does not set and the default port. */
function targetOf(host: HostEntryWire, resolved: ResolvedHostWire | undefined): string {
  const user = resolved?.ssh.user.value;
  const port = resolved?.ssh.port.value;
  return `${user === undefined ? '' : `${user}@`}${host.address}${port === undefined || port === 22 ? '' : `:${String(port)}`}`;
}

/** A stable hue per group, so a group's hosts share a tint wherever they show. */
function hueOf(key: string): number {
  let hue = 0;
  for (const char of key) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return hue;
}

const MAX_TAGS = 3;

interface CardProps {
  readonly host: HostEntryWire;
  readonly resolved: ResolvedHostWire | undefined;
  /** The tint of a host whose OS is not known: its group's, or its own outside any group. */
  readonly hue: number;
  readonly layout: HostsLayout;
  readonly selected: boolean;
  readonly tabbable: boolean;
  readonly onSelect: () => void;
}

/**
 * The card the last single press landed on, and where. The press picks the host (its focus does), the
 * details open, and the right panel narrowing the content can move the card out from under the pointer
 * before the release, let alone the second press of a double-click: so the press is what is remembered,
 * and the second press connects that host wherever it lands.
 */
let lastPress: { readonly id: string; readonly x: number; readonly y: number; readonly at: number } | undefined;
/** How far apart, in time and in pixels, the two presses of a double-click may be. */
const DOUBLE_CLICK_MS = 600;
const DOUBLE_CLICK_PX = 6;
/** Until when the click that follows a connecting press is swallowed, so it presses nothing it lands on. */
let swallowClickUntil = 0;

function HostCard({ host, resolved, hue, layout, selected, tabbable, onSelect }: CardProps) {
  const status = sessionStatus(useHostsStore((s) => s.sessions[host.id]));
  const osEntry = useHostsStore((s) => (resolved === undefined ? undefined : s.osByHost[osKeyOf(resolved)]));
  const os = osOf(osEntry);
  const osText = osTextOf(osEntry);
  // Whether this card's details were already showing when the press began: a click on it then
  // hides them, rather than the focus the press brings picking it again.
  const pressedWhileShown = useRef(false);
  const connect = (): void => {
    openTerminalFor(host.id);
  };
  const warning =
    resolved === undefined
      ? 'unresolved'
      : resolved.incomplete === undefined
        ? undefined
        : `needs ${resolved.incomplete.field}`;
  const grid = layout === 'grid';
  const extraTags = host.tags.length - MAX_TAGS;
  const actions = (
    <span
      className={`flex shrink-0 items-center gap-1 transition-opacity ${
        selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
      }`}
    >
      <HostActionsButton host={host} />
    </span>
  );
  const tags = host.tags.length > 0 && (
    <span className="flex min-w-0 flex-wrap gap-1">
      {host.tags.slice(0, MAX_TAGS).map((tag) => (
        <span key={tag} className="rounded-full border border-hairline px-1.5 text-xs leading-4 text-fg-subtle">
          {tag}
        </span>
      ))}
      {extraTags > 0 && <span className="text-xs leading-4 text-fg-subtle">+{extraTags}</span>}
    </span>
  );
  return (
    <HostMenu host={host}>
      <li
        tabIndex={tabbable ? 0 : -1}
        data-testid={`host-row-${host.id}`}
        data-host-card={host.id}
        data-selected={selected || undefined}
        title={`${host.name} — double-click to connect`}
        className={`group flex min-w-0 cursor-default border bg-surface-raised hover:border-hairline-strong hover:bg-surface-hover focus-visible:outline-none ${
          selected ? 'border-accent ring-1 ring-accent' : 'border-hairline'
        } ${grid ? 'items-center gap-2.5 rounded-md p-2' : 'items-center gap-3 rounded-md px-3 py-1'}`}
        onMouseDown={(e) => {
          pressedWhileShown.current = selected && useHostsStore.getState().detailsOpen;
          if (e.button === 0 && e.detail === 1) {
            lastPress = { id: host.id, x: e.clientX, y: e.clientY, at: performance.now() };
          }
        }}
        onClick={(e) => {
          // The second click of a double-click belongs to connecting (see `lastPress`).
          if (e.detail > 1) return;
          if (pressedWhileShown.current) useHostsStore.getState().setDetailsOpen(false);
          else onSelect();
        }}
        onFocus={(e) => {
          if (e.target === e.currentTarget) onSelect();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) connect();
        }}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <span
            title={osText}
            className={`relative flex shrink-0 items-center justify-center rounded-md ${grid ? 'size-7' : 'size-6'} ${
              os === undefined ? '' : 'bg-surface-sunken text-fg-default'
            }`}
            style={
              os === undefined
                ? { backgroundColor: `hsl(${String(hue)} 65% 50% / 0.2)`, color: `hsl(${String(hue)} 70% 60%)` }
                : undefined
            }
          >
            <OsIcon os={os} size={grid ? 16 : 14} />
            <span
              aria-label={status.label}
              className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface-raised bg-current ${status.color}`}
            />
          </span>
          <span className={`flex min-w-0 flex-1 ${grid ? 'flex-col' : 'items-baseline gap-3'}`}>
            <span className="truncate text-sm leading-5 font-medium text-fg-default">{host.name}</span>
            <span className="truncate text-xs leading-4 text-fg-subtle">
              {osText !== undefined && <span>{osText} · </span>}
              <span className="font-mono">{targetOf(host, resolved)}</span>
            </span>
          </span>
          {warning !== undefined && (
            <span className="shrink-0 self-start rounded-full border border-status-warning px-1.5 text-xs leading-4 text-status-warning">
              {warning}
            </span>
          )}
          {!grid && tags}
          {actions}
        </span>
      </li>
    </HostMenu>
  );
}

/** The card a keystroke moves to from `from`, by what is drawn: the grid is measured, rows are a line. */
function nextCard(cards: readonly HTMLElement[], from: HTMLElement, key: string): HTMLElement | undefined {
  const index = cards.indexOf(from);
  if (key === 'Home') return cards[0];
  if (key === 'End') return cards.at(-1);
  if (key === 'ArrowRight') return cards[index + 1];
  if (key === 'ArrowLeft') return cards[index - 1];
  const down = key === 'ArrowDown';
  const box = from.getBoundingClientRect();
  if (box.height === 0) return cards[index + (down ? 1 : -1)];
  const centre = box.left + box.width / 2;
  let best: { card: HTMLElement; rowGap: number; xGap: number } | undefined;
  for (const card of cards) {
    const other = card.getBoundingClientRect();
    const rowGap = down ? other.top - box.bottom : box.top - other.bottom;
    if (card === from || rowGap < -1) continue;
    const xGap = Math.abs(other.left + other.width / 2 - centre);
    if (best === undefined || rowGap < best.rowGap - 1 || (Math.abs(rowGap - best.rowGap) <= 1 && xGap < best.xGap)) {
      best = { card, rowGap, xGap };
    }
  }
  return best?.card;
}

const NAV_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

export function HostCards({
  prefs,
  onPrefs,
}: {
  readonly prefs: HostsPrefs;
  readonly onPrefs: (change: Partial<HostsPrefs>) => void;
}) {
  const file = useHostsStore((s) => s.file);
  const resolved = useHostsStore((s) => s.resolved);
  const sessions = useHostsStore((s) => s.sessions);
  const filter = useHostsStore((s) => s.filter);
  const selectedTags = useHostsStore((s) => s.selectedTags);
  const groupFilter = useHostsStore((s) => s.groupFilter);
  const visibleHosts = useHostsStore((s) => s.visibleHosts);
  const openDialog = useHostsStore((s) => s.openDialog);
  const selected = useHostsStore((s) => s.selectedHostId);
  const selectHost = useHostsStore((s) => s.selectHost);
  const containerRef = useRef<HTMLDivElement>(null);

  // Taken before anything under the pointer sees it: the second press may land on another card, a gap
  // or the details panel the first one opened, and connecting is all it should do.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent): void => {
      const first = lastPress;
      if (e.button !== 0 || e.detail !== 2 || first === undefined) return;
      lastPress = undefined;
      const near = Math.abs(e.clientX - first.x) <= DOUBLE_CLICK_PX && Math.abs(e.clientY - first.y) <= DOUBLE_CLICK_PX;
      if (!near || performance.now() - first.at > DOUBLE_CLICK_MS) return;
      e.preventDefault();
      e.stopPropagation();
      swallowClickUntil = performance.now() + DOUBLE_CLICK_MS;
      openTerminalFor(first.id);
    };
    const onClick = (e: MouseEvent): void => {
      if (e.detail < 2 || performance.now() > swallowClickUntil) return;
      swallowClickUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('click', onClick, true);
    };
  }, []);

  if (file.groups.length === 0 && file.hosts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-hairline-strong px-6 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-accent-muted text-fg-default">
          <Server size={22} aria-hidden="true" />
        </span>
        <h3 className="text-md font-medium text-fg-default">Add your first host</h3>
        <p className="max-w-sm text-sm text-fg-subtle">
          Save the servers you connect to, sort them into groups, and open a terminal with a double-click.
        </p>
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => {
              openDialog({ mode: 'new-host' });
            }}
          >
            <Plus size={13} aria-hidden /> Add host
          </Button>
          <Button
            onClick={() => {
              useHostsStore.getState().setImportOpen(true);
            }}
          >
            Import from SSH config
          </Button>
        </div>
      </div>
    );
  }

  const narrowed = filter.trim() !== '' || selectedTags.length > 0;
  const hostsById = new Map(resolved.map((h) => [h.id, h] as const));
  // A host the resolver did not place still shows (degraded) unless a filter is active: it has nothing to match on.
  const visible = new Set(visibleHosts().map((h) => h.id));
  const shown = (host: HostEntryWire): boolean => !narrowed || visible.has(host.id);

  // A group that is gone (deleted, or another workspace's) filters nothing.
  const only =
    groupFilter !== undefined && flattenGroups(file).some(({ group }) => group.id === groupFilter)
      ? groupFilter
      : undefined;
  const sections = sectionsOf(file, only)
    .map((section) => ({ ...section, hosts: sortHosts(section.hosts.filter(shown), prefs.sort, sessions) }))
    // The top level needs no heading when it is all there is; an empty group keeps its heading
    // (its menu is how a host gets into it) unless a filter is narrowing.
    .filter((section) =>
      section.group === undefined ? section.hosts.length > 0 : !narrowed || section.hosts.length > 0,
    );
  const headed = file.groups.length > 0;
  // A search shows every match, folded or not.
  const folded = (key: string): boolean => headed && !narrowed && prefs.collapsed.includes(key);
  const toggle = (key: string): void => {
    onPrefs({
      collapsed: prefs.collapsed.includes(key) ? prefs.collapsed.filter((id) => id !== key) : [...prefs.collapsed, key],
    });
  };

  if (sections.length === 0) {
    return <p className="p-1 text-sm text-fg-subtle">No host matches the filter.</p>;
  }

  const order = sections.flatMap((s) => (folded(s.group?.id ?? TOP_LEVEL) ? [] : s.hosts.map((h) => h.id)));
  const tabbableId = selected !== undefined && order.includes(selected) ? selected : order[0];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const from = e.target as HTMLElement;
    if (!NAV_KEYS.has(e.key) || from.dataset['hostCard'] === undefined) return;
    const cards = [...(containerRef.current?.querySelectorAll<HTMLElement>('[data-host-card]') ?? [])];
    const target = nextCard(cards, from, e.key);
    e.preventDefault();
    if (target === undefined) return;
    selectHost(target.dataset['hostCard']);
    target.focus();
  };

  return (
    <div ref={containerRef} className="flex flex-col gap-5" onKeyDown={onKeyDown}>
      {sections.map((section) => {
        const key = section.group?.id ?? TOP_LEVEL;
        const isFolded = folded(key);
        const hueFor = (host: HostEntryWire): number => hueOf(section.group?.id ?? host.id);
        const heading = (
          <div className="group/section flex items-center gap-2">
            <h3>
              <button
                type="button"
                aria-expanded={!isFolded}
                onClick={() => {
                  toggle(key);
                }}
                className="flex items-center gap-1 rounded text-xs font-medium tracking-wider text-fg-subtle uppercase hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
              >
                <ChevronRight
                  size={13}
                  aria-hidden="true"
                  className={`transition-transform ${isFolded ? '' : 'rotate-90'}`}
                />
                <span className="truncate">{section.title}</span>
                <span className="font-normal">{section.hosts.length}</span>
              </button>
            </h3>
            <button
              type="button"
              aria-label={`Add a host to ${section.title}`}
              onClick={() => {
                openDialog(
                  section.group === undefined ? { mode: 'new-host' } : { mode: 'new-host', parent: section.group.id },
                );
              }}
              className="ml-auto flex items-center gap-1 rounded px-1 text-xs text-fg-subtle opacity-0 group-hover/section:opacity-100 hover:text-fg-default focus-visible:opacity-100"
            >
              <Plus size={12} aria-hidden="true" /> Add host
            </button>
          </div>
        );
        return (
          <section key={key} aria-label={section.title} className="flex flex-col gap-2">
            {headed && (section.group === undefined ? heading : <GroupMenu group={section.group}>{heading}</GroupMenu>)}
            {isFolded ? null : section.hosts.length === 0 ? (
              <p className="text-xs text-fg-subtle">No hosts in this group yet.</p>
            ) : (
              <ul
                aria-label={`Hosts in ${section.title}`}
                className={
                  prefs.layout === 'grid'
                    ? 'grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2'
                    : 'flex flex-col gap-1'
                }
              >
                {section.hosts.map((host) => (
                  <HostCard
                    key={host.id}
                    host={host}
                    resolved={hostsById.get(host.id)}
                    hue={hueFor(host)}
                    layout={prefs.layout}
                    selected={selected === host.id}
                    tabbable={tabbableId === host.id}
                    onSelect={() => {
                      selectHost(host.id);
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
