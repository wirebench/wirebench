import { useEffect } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../components/button.js';
import { HostDialog } from './host-dialog.js';
import { HostTree } from './host-tree.js';
import { useHostsStore } from './hosts-store.js';
import { TrustDialog } from './trust-dialog.js';

const INPUT_CLASS =
  'w-full rounded border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';

/** The Hosts sidebar view: filter, tag chips, problems from `hosts.yaml`, and the tree. */
export function HostsView() {
  const refresh = useHostsStore((s) => s.refresh);
  const resolved = useHostsStore((s) => s.resolved);
  const problems = useHostsStore((s) => s.problems);
  const filter = useHostsStore((s) => s.filter);
  const setFilter = useHostsStore((s) => s.setFilter);
  const selectedTags = useHostsStore((s) => s.selectedTags);
  const toggleTag = useHostsStore((s) => s.toggleTag);
  const openDialog = useHostsStore((s) => s.openDialog);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tags = [...new Set(resolved.flatMap((h) => h.tags))].sort();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          onClick={() => {
            openDialog({ mode: 'new-host' });
          }}
        >
          <Plus size={13} aria-hidden /> New host
        </Button>
        <Button
          onClick={() => {
            openDialog({ mode: 'new-group' });
          }}
        >
          New group
        </Button>
      </div>
      <input
        type="search"
        aria-label="Filter hosts"
        placeholder="Filter by name, address or tag"
        className={INPUT_CLASS}
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
        }}
      />
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by tag">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={selectedTags.includes(tag)}
              onClick={() => {
                toggleTag(tag);
              }}
              className={`rounded-full border border-hairline px-2 py-0.5 text-xs ${
                selectedTags.includes(tag)
                  ? 'bg-accent-muted text-fg-default'
                  : 'text-fg-subtle hover:bg-surface-raised'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {problems.length > 0 && (
        <ul role="alert" aria-label="Hosts problems" className="flex flex-col gap-1 text-sm">
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
      <HostTree />
      <HostDialog />
      <TrustDialog />
    </div>
  );
}
