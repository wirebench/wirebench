/**
 * The Snippets view in the SSH area's fixed first tab: the workspace's `snippets.yaml` as packages of rows,
 * then the snippets in no package, with a filter and tag chips.
 */
import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  KeyRound,
  MoreHorizontal,
  Play,
  Plus,
  ShieldAlert,
  SquareTerminal,
  TextCursorInput,
  Variable,
} from 'lucide-react';
import { Button, SPLIT_HEAD_CLASS, SPLIT_TAIL_CLASS } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import type { SnippetListItemWire, SnippetsFileWire } from '../../../../shared/snippets-wire.js';
import { INPUT_CLASS as FIELD_CLASS } from '../inherited-field.js';
import {
  addPackage,
  duplicateSnippet,
  moveSnippet,
  removePackage,
  removeSnippet,
  renamePackage,
} from './snippet-edit.js';
import { startRun } from './run.js';
import { filterSnippets, useSnippetsStore } from './snippets-store.js';
import { SshEmptyState, SshNoMatches, SshView, SshViewHeader } from '../ssh-view-frame.js';
import { SSH_VIEWS } from '../ssh-views.js';

const CHIP_CLASS = 'rounded-full border px-2 py-0.5 text-xs';
const MENU_CONTENT_CLASS = 'z-dropdown min-w-44 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';
const MENU_ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent-muted';
const ICON_BUTTON_CLASS =
  'inline-flex size-6 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg-default';

/** Saves an edit made from a menu; a refusal shows as the view's problem banner, as a failed read does. */
function saveFile(file: SnippetsFileWire): void {
  void useSnippetsStore
    .getState()
    .save(file)
    .then((answer) => {
      if (!answer.ok)
        useSnippetsStore.setState({ problems: [{ code: answer.error.code, message: answer.error.message }] });
    })
    .catch(() => undefined);
}
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
  const openEditor = useSnippetsStore((s) => s.openEditor);
  const [naming, setNaming] = useState(false);
  const tags = [...new Set(snippets.flatMap((s) => s.tags))].sort();
  const filtering = filter.trim() !== '' || selectedTags.length > 0;
  const sections = sectionsOf(file.packages, filterSnippets(snippets, filter, selectedTags), filtering);

  useEffect(() => {
    useSnippetsStore
      .getState()
      .refresh()
      .catch(() => undefined); // the problems banner stays as it was; the next change reads again
  }, []);

  return (
    <SshView>
      <SshViewHeader
        title={SSH_VIEWS.snippets.label}
        count={snippets.length}
        search={{ value: filter, onChange: setFilter, label: 'Filter snippets', placeholder: 'Search snippets…' }}
        description="Commands you run often, with their variables, to run on one host or many."
        actions={
          <div className="ml-auto flex">
            <Button
              variant="primary"
              className={SPLIT_HEAD_CLASS}
              onClick={() => {
                openEditor({ mode: 'new' });
              }}
            >
              <Plus size={13} aria-hidden /> New snippet
            </Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button variant="primary" aria-label="More ways to add" className={SPLIT_TAIL_CLASS}>
                  <ChevronDown size={13} aria-hidden="true" />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
                  <DropdownMenu.Item
                    className={MENU_ITEM_CLASS}
                    onSelect={() => {
                      openEditor({ mode: 'new' });
                    }}
                  >
                    <SquareTerminal size={13} aria-hidden="true" /> New snippet
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className={MENU_ITEM_CLASS}
                    onSelect={() => {
                      setNaming(true);
                    }}
                  >
                    <FolderPlus size={13} aria-hidden="true" /> New package
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        }
      />
      <NameDialog
        open={naming}
        title="New package"
        action="Create"
        initial=""
        onOpenChange={setNaming}
        onSubmit={(name) => {
          saveFile(addPackage(useSnippetsStore.getState().file, name).file);
        }}
      />
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
      {snippets.length === 0 && file.packages.length === 0 ? (
        <SshEmptyState
          icon={SquareTerminal}
          text="Save the commands you run often, then run them on one host or many at once."
          testId="snippets-empty"
        >
          <Button
            variant="primary"
            onClick={() => {
              openEditor({ mode: 'new' });
            }}
          >
            <Plus size={13} aria-hidden /> New snippet
          </Button>
        </SshEmptyState>
      ) : sections.length === 0 ? (
        <SshNoMatches
          text="No snippet matches the search."
          onClear={() => {
            useSnippetsStore.setState({ filter: '', selectedTags: [] });
          }}
        />
      ) : (
        sections.map((section) => <SnippetSection key={section.id} section={section} />)
      )}
    </SshView>
  );
}

function SnippetSection({ section }: { readonly section: Section }) {
  const collapsed = useSnippetsStore((s) => s.collapsed.includes(section.id));
  const toggleCollapsed = useSnippetsStore((s) => s.toggleCollapsed);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section aria-label={section.name} className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => {
            toggleCollapsed(section.id);
          }}
          className="flex items-center gap-1 rounded px-1 text-sm font-medium text-fg-muted hover:text-fg-default"
        >
          <Chevron size={14} aria-hidden="true" />
          {section.name}
          <span data-testid="snippet-section-count" className="ml-1 text-xs font-normal text-fg-subtle">
            {section.items.length}
          </span>
        </button>
        {section.id !== NO_PACKAGE && <PackageMenu id={section.id} name={section.name} />}
      </div>
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
  const openEditor = useSnippetsStore((s) => s.openEditor);
  return (
    <li
      data-snippet-id={item.id}
      data-testid={`snippet-item-${item.id}`}
      className={`group flex items-center pr-2 ${selected ? 'bg-accent-muted' : 'hover:bg-surface-raised'}`}
    >
      <button
        type="button"
        data-testid={`snippet-row-${item.id}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          openEditor({ mode: 'edit', id: item.id });
        }}
        onDoubleClick={() => {
          startRun(item);
        }}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
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
      <span className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          aria-label={`Run ${item.name}`}
          title="Run"
          className={ICON_BUTTON_CLASS}
          onClick={() => {
            startRun(item);
          }}
        >
          <Play size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`Insert ${item.name}`}
          title="Insert (without pressing Enter)"
          className={ICON_BUTTON_CLASS}
          onClick={() => {
            startRun(item, { enter: false });
          }}
        >
          <TextCursorInput size={14} aria-hidden="true" />
        </button>
      </span>
      <SnippetMenu item={item} />
    </li>
  );
}

/** The script as written in the file (the list holds only its first line). */
function scriptOf(file: SnippetsFileWire, id: string): string | undefined {
  return [...file.packages.flatMap((p) => p.snippets), ...file.snippets].find((s) => s.id === id)?.script;
}

/** Run…, Insert, Edit, Duplicate, Move to package…, Copy script and Delete (after asking) for one snippet. */
function SnippetMenu({ item }: { readonly item: SnippetListItemWire }) {
  const packages = useSnippetsStore((s) => s.file.packages);
  const openEditor = useSnippetsStore((s) => s.openEditor);
  const [deleting, setDeleting] = useState(false);
  const file = (): SnippetsFileWire => useSnippetsStore.getState().file;
  const targets: { id: string | undefined; name: string }[] = [
    ...packages.filter((p) => p.id !== item.packageId).map((p) => ({ id: p.id, name: p.name })),
    ...(item.packageId === undefined ? [] : [{ id: undefined, name: 'No package' }]),
  ];
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label="Snippet actions" className={ICON_BUTTON_CLASS}>
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              onSelect={() => {
                startRun(item, { ask: true });
              }}
            >
              Run…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              onSelect={() => {
                startRun(item, { enter: false });
              }}
            >
              Insert
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              onSelect={() => {
                openEditor({ mode: 'edit', id: item.id });
              }}
            >
              Edit
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              onSelect={() => {
                saveFile(duplicateSnippet(file(), item.id).file);
              }}
            >
              Duplicate
            </DropdownMenu.Item>
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className={MENU_ITEM_CLASS} disabled={targets.length === 0}>
                Move to package…
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className={MENU_CONTENT_CLASS}>
                  {targets.map((t) => (
                    <DropdownMenu.Item
                      key={t.id ?? ''}
                      className={MENU_ITEM_CLASS}
                      onSelect={() => {
                        saveFile(moveSnippet(file(), item.id, t.id));
                      }}
                    >
                      {t.name}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              onSelect={() => {
                const script = scriptOf(file(), item.id);
                if (script !== undefined) void navigator.clipboard.writeText(script).catch(() => undefined);
              }}
            >
              Copy script
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              onSelect={() => {
                setDeleting(true);
              }}
            >
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete snippet"
        description={`"${item.name}" is removed from snippets.yaml for everyone using this workspace.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          saveFile(removeSnippet(file(), item.id));
        }}
      />
    </>
  );
}

/** Rename… and Delete for a package; Delete is refused while the package holds snippets. */
function PackageMenu({ id, name }: { readonly id: string; readonly name: string }) {
  const holds = useSnippetsStore((s) => s.file.packages.find((p) => p.id === id)?.snippets.length ?? 0);
  const [renaming, setRenaming] = useState(false);
  const file = (): SnippetsFileWire => useSnippetsStore.getState().file;
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label="Package actions" className={ICON_BUTTON_CLASS}>
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className={MENU_CONTENT_CLASS}>
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              onSelect={() => {
                setRenaming(true);
              }}
            >
              Rename…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              disabled={holds > 0}
              onSelect={() => {
                saveFile(removePackage(file(), id));
              }}
            >
              {holds > 0 ? 'Delete (holds snippets: move or delete them first)' : 'Delete'}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <NameDialog
        open={renaming}
        title="Rename package"
        action="Rename"
        initial={name}
        onOpenChange={setRenaming}
        onSubmit={(next) => {
          saveFile(renamePackage(file(), id, next));
        }}
      />
    </>
  );
}

/** Asks a package's name: for a new package, or a rename. */
function NameDialog(props: {
  readonly open: boolean;
  readonly title: string;
  readonly action: string;
  readonly initial: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (name: string) => void;
}) {
  const { open, title, action, initial, onOpenChange, onSubmit } = props;
  const [name, setName] = useState(initial);
  const id = useId();
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg">
          <Dialog.Title className="text-md font-medium text-fg-default">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">A package groups snippets in snippets.yaml.</Dialog.Description>
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() === '') return;
              onSubmit(name.trim());
              onOpenChange(false);
            }}
          >
            <label htmlFor={id} className="flex flex-col gap-1 text-xs text-fg-subtle">
              Package name
              <input
                id={id}
                className={FIELD_CLASS}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={name.trim() === ''}>
                {action}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Marker({ label, icon: Icon }: { readonly label: string; readonly icon: typeof Variable }) {
  return (
    <span role="img" aria-label={label} title={label}>
      <Icon size={13} aria-hidden="true" />
    </span>
  );
}
