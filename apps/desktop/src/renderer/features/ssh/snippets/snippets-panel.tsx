/**
 * The Snippets view in the SSH area's fixed first tab: the workspace's `snippets.yaml` as packages of rows,
 * then the snippets in no package, with a filter and tag chips.
 */
import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, KeyRound, Search, ShieldAlert, Variable } from 'lucide-react';
import type { SnippetListItemWire } from '../../../../shared/snippets-wire.js';
import { detectPlatform } from '../../../lib/platform.js';
import { filterSnippets, useSnippetsStore } from './snippets-store.js';

const INPUT_CLASS =
  'w-full rounded-md border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';
const CHIP_CLASS = 'rounded-full border px-2 py-0.5 text-xs';
const chipState = (on: boolean): string =>
  on ? 'border-accent bg-accent-muted text-fg-default' : 'border-hairline text-fg-subtle hover:bg-surface-raised';

/** The id the "No package" section is folded under; never a package id (those match `[a-z0-9]…`). */
const NO_PACKAGE = '';

interface Section {
  readonly id: string;
  readonly name: string;
  readonly items: readonly SnippetListItemWire[];
}

/** Packages in file order, then the snippets in no package; with a filter on, only sections with a match. */
function sectionsOf(
  packages: readonly { id: string; name: string }[],
  items: readonly SnippetListItemWire[],
  filtering: boolean,
): Section[] {
  const sections: Section[] = [
    ...packages.map((p) => ({ id: p.id, name: p.name, items: items.filter((s) => s.packageId === p.id) })),
    { id: NO_PACKAGE, name: 'No package', items: items.filter((s) => s.packageId === undefined) },
  ];
  return sections.filter((s) => s.items.length > 0 || (!filtering && s.id !== NO_PACKAGE));
}

export function SnippetsPanel() {
  const file = useSnippetsStore((s) => s.file);
  const snippets = useSnippetsStore((s) => s.snippets);
  const problems = useSnippetsStore((s) => s.problems);
  const filter = useSnippetsStore((s) => s.filter);
  const setFilter = useSnippetsStore((s) => s.setFilter);
  const selectedTags = useSnippetsStore((s) => s.selectedTags);
  const toggleTag = useSnippetsStore((s) => s.toggleTag);
  const searchRef = useRef<HTMLInputElement>(null);
  const mac = detectPlatform() === 'mac';
  const tags = [...new Set(snippets.flatMap((s) => s.tags))].sort();
  const filtering = filter.trim() !== '' || selectedTags.length > 0;
  const sections = sectionsOf(file.packages, filterSnippets(snippets, filter, selectedTags), filtering);

  useEffect(() => {
    useSnippetsStore
      .getState()
      .refresh()
      .catch(() => undefined); // the problems banner stays as it was; the next change reads again
  }, []);

  // ⌘F (Ctrl+F elsewhere) goes to the filter while this view is in front.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [mac]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 flex items-baseline gap-2 text-lg font-medium text-fg-default">
          Snippets <span className="text-sm font-normal text-fg-subtle">{snippets.length}</span>
        </h2>
        <label className="relative flex max-w-md min-w-48 flex-1 items-center">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2 text-fg-subtle" />
          <input
            ref={searchRef}
            type="search"
            aria-label="Filter snippets"
            placeholder="Search snippets…"
            className={`${INPUT_CLASS} pr-12 pl-7`}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter !== '') {
                e.stopPropagation();
                setFilter('');
              }
            }}
          />
          <kbd className="pointer-events-none absolute right-2 rounded border border-hairline px-1 font-sans text-xs text-fg-subtle">
            {mac ? '⌘F' : 'Ctrl+F'}
          </kbd>
        </label>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by tag">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={selectedTags.includes(tag)}
              onClick={() => {
                toggleTag(tag);
              }}
              className={`${CHIP_CLASS} ${chipState(selectedTags.includes(tag))}`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {problems.length > 0 && (
        <ul role="alert" aria-label="Snippets problems" className="flex flex-col gap-1 text-sm">
          {problems.map((p, i) => (
            <li
              key={`${p.code}-${String(i)}`}
              className="rounded border border-status-danger px-2 py-1 text-fg-default"
            >
              <span className="font-mono text-xs text-status-danger">{p.code}</span> <span>{p.message}</span>
              {p.path !== undefined && <span className="ml-1 font-mono text-xs text-fg-subtle">{p.path}</span>}
            </li>
          ))}
        </ul>
      )}
      {sections.length === 0 ? (
        <p className="text-sm text-fg-subtle">
          {filtering ? 'No snippet matches the filter.' : 'No snippets yet. They are kept in snippets.yaml.'}
        </p>
      ) : (
        sections.map((section) => <SnippetSection key={section.id} section={section} />)
      )}
    </div>
  );
}

function SnippetSection({ section }: { readonly section: Section }) {
  const collapsed = useSnippetsStore((s) => s.collapsed.includes(section.id));
  const toggleCollapsed = useSnippetsStore((s) => s.toggleCollapsed);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section aria-label={section.name} className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => {
          toggleCollapsed(section.id);
        }}
        className="flex items-center gap-1 self-start rounded px-1 text-sm font-medium text-fg-muted hover:text-fg-default"
      >
        <Chevron size={14} aria-hidden="true" />
        {section.name}
        <span data-testid="snippet-section-count" className="ml-1 text-xs font-normal text-fg-subtle">
          {section.items.length}
        </span>
      </button>
      {!collapsed && section.items.length > 0 && (
        <ul className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
          {section.items.map((item) => (
            <SnippetRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SnippetRow({ item }: { readonly item: SnippetListItemWire }) {
  const selected = useSnippetsStore((s) => s.selectedId === item.id);
  const select = useSnippetsStore((s) => s.select);
  return (
    <li data-snippet-id={item.id}>
      <button
        type="button"
        data-testid={`snippet-row-${item.id}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          select(item.id);
        }}
        className={`flex w-full items-center gap-3 px-3 py-2 text-left ${
          selected ? 'bg-accent-muted' : 'hover:bg-surface-raised'
        }`}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-fg-default">{item.name}</span>
          <span className="truncate font-mono text-xs text-fg-subtle">{item.firstLine}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-fg-subtle">
          {item.variables.length > 0 && <Marker label="Has variables" icon={Variable} />}
          {item.secrets.length > 0 && <Marker label="Uses a secret" icon={KeyRound} />}
          {item.confirm && <Marker label="Always confirms" icon={ShieldAlert} />}
        </span>
      </button>
    </li>
  );
}

function Marker({ label, icon: Icon }: { readonly label: string; readonly icon: typeof Variable }) {
  return (
    <span role="img" aria-label={label} title={label}>
      <Icon size={13} aria-hidden="true" />
    </span>
  );
}
