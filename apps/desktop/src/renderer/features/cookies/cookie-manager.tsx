/**
 * The Cookies tab (cookie jar spec §3): the open workspace's jar, grouped by domain. Values stay
 * masked until *Show values*, which this tab keeps only while it is open. A value is edited in place;
 * everything else goes through the Edit cookie dialog. Past 500 rows the table virtualises.
 */
import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { IconButton } from '../../components/icon-button.js';
import { KV_INPUT_CLASS, useCommittedDraft } from '../../components/kv-table.js';
import { subscribeToCookies, useCookiesStore } from '../../state/cookies.js';
import type { StoredCookieWire } from '../../../shared/wire-types.js';
import { CookieDialog } from './cookie-dialog.js';

const VIRTUALISE_ABOVE = 500;
const ROW_HEIGHT = 32;
const MASK = '••••••';

/** "Session", or the expiry as a local date and time. */
export function formatExpires(cookie: StoredCookieWire): string {
  return cookie.expiresAt === undefined ? 'Session' : new Date(cookie.expiresAt).toLocaleString();
}

type Row =
  | { readonly kind: 'group'; readonly domain: string; readonly count: number }
  | { readonly kind: 'cookie'; readonly cookie: StoredCookieWire };

/** A heading per domain, then its cookies: by domain, then name, then path. */
function rowsOf(cookies: readonly StoredCookieWire[]): Row[] {
  const sorted = [...cookies].sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
  const counts = new Map<string, number>();
  for (const cookie of sorted) {
    counts.set(cookie.domain, (counts.get(cookie.domain) ?? 0) + 1);
  }
  const rows: Row[] = [];
  let domain: string | undefined;
  for (const cookie of sorted) {
    if (cookie.domain !== domain) {
      domain = cookie.domain;
      rows.push({ kind: 'group', domain, count: counts.get(domain) ?? 0 });
    }
    rows.push({ kind: 'cookie', cookie });
  }
  return rows;
}

function rowKey(row: Row): string {
  return row.kind === 'group' ? `group:${row.domain}` : `${row.cookie.domain}\n${row.cookie.path}\n${row.cookie.name}`;
}

function CookieRow({
  cookie,
  showValues,
  onCommitValue,
  onEdit,
  onDelete,
}: {
  readonly cookie: StoredCookieWire;
  readonly showValues: boolean;
  readonly onCommitValue: (value: string) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const valueField = useCommittedDraft(cookie.value, onCommitValue);
  return (
    <tr
      data-testid="cookie-row"
      className="border-b border-hairline hover:bg-surface-hover"
      style={{ height: ROW_HEIGHT }}
    >
      <td className="px-2 py-1 font-mono break-words text-fg-default">
        {cookie.name}
        {cookie.hostOnly && (
          <span
            data-testid="cookie-host-only"
            className="ml-2 rounded bg-surface-raised px-1 font-sans text-xs text-fg-subtle"
          >
            host only
          </span>
        )}
      </td>
      <td className="px-2 py-1">
        {showValues ? (
          <input
            aria-label={`Value of ${cookie.name}`}
            data-testid="cookie-value"
            className={KV_INPUT_CLASS}
            {...valueField}
          />
        ) : (
          <span data-testid="cookie-value-masked" className="font-mono text-fg-muted">
            {MASK}
          </span>
        )}
      </td>
      <td className="px-2 py-1 font-mono break-words text-fg-muted">{cookie.path}</td>
      <td data-testid="cookie-expires" className="px-2 py-1 text-fg-muted">
        {formatExpires(cookie)}
      </td>
      <td className="px-2 py-1 text-center text-fg-muted">{cookie.secure ? 'Yes' : ''}</td>
      <td className="px-2 py-1 text-center text-fg-muted">{cookie.httpOnly ? 'Yes' : ''}</td>
      <td className="px-2 py-1">
        <div className="flex justify-end gap-1">
          <IconButton label={`Edit ${cookie.name}`} data-testid="cookie-edit" onClick={onEdit}>
            <Pencil size={13} aria-hidden="true" />
          </IconButton>
          <IconButton label={`Delete ${cookie.name}`} data-testid="cookie-delete" onClick={onDelete}>
            <Trash2 size={13} aria-hidden="true" />
          </IconButton>
        </div>
      </td>
    </tr>
  );
}

export function CookieManager() {
  const cookies = useCookiesStore((state) => state.cookies);
  const persisted = useCookiesStore((state) => state.persisted);
  const [showValues, setShowValues] = useState(false);
  const [editing, setEditing] = useState<{ readonly cookie: StoredCookieWire | undefined } | undefined>(undefined);
  const [confirmClear, setConfirmClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeToCookies(), []);

  const rows = rowsOf(cookies);
  const virtualised = rows.length > VIRTUALISE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtualised ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();
  const visible = virtualised
    ? items.flatMap((item) => {
        const row = rows[item.index];
        return row === undefined ? [] : [row];
      })
    : rows;
  const paddingTop = virtualised ? (items[0]?.start ?? 0) : 0;
  const paddingBottom = virtualised ? virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0) : 0;

  const store = useCookiesStore.getState;

  return (
    <section data-testid="cookie-manager" aria-label="Cookies" className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-md font-medium text-fg-default">Cookies</h2>
        <span className="text-sm text-fg-subtle">{`${String(cookies.length)} in this workspace`}</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-fg-muted">
            <input
              type="checkbox"
              data-testid="cookie-show-values"
              checked={showValues}
              onChange={(event) => {
                setShowValues(event.target.checked);
              }}
            />
            Show values
          </label>
          <Button
            data-testid="cookie-add"
            onClick={() => {
              setEditing({ cookie: undefined });
            }}
          >
            <Plus size={14} aria-hidden="true" />
            Add cookie
          </Button>
          <Button
            data-testid="cookie-clear-all"
            disabled={cookies.length === 0}
            onClick={() => {
              setConfirmClear(true);
            }}
          >
            Clear all
          </Button>
        </div>
      </div>

      {!persisted && (
        <p data-testid="cookie-persistence-note" role="note" className="text-sm text-status-warning">
          Cookies are kept for this session only: this system has no secure storage.
        </p>
      )}

      {cookies.length === 0 ? (
        <p data-testid="cookie-empty" className="text-sm text-fg-subtle">
          No cookies yet. Responses store cookies here; a request sends them when its Send cookies setting is on.
        </p>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-md border border-hairline">
          <table aria-label="Cookies" className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-[20%]" />
              <col />
              <col className="w-[14%]" />
              <col className="w-[18%]" />
              <col className="w-16" />
              <col className="w-16" />
              <col className="w-16" />
            </colgroup>
            <thead>
              <tr className="border-b border-hairline text-left text-xs tracking-wider text-fg-subtle uppercase">
                <th className="px-2 py-1.5 font-medium">Name</th>
                <th className="px-2 py-1.5 font-medium">Value</th>
                <th className="px-2 py-1.5 font-medium">Path</th>
                <th className="px-2 py-1.5 font-medium">Expires</th>
                <th className="px-2 py-1.5 font-medium">Secure</th>
                <th className="px-2 py-1.5 font-medium">HttpOnly</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {paddingTop > 0 && <tr aria-hidden="true" style={{ height: paddingTop }} />}
              {visible.map((row) =>
                row.kind === 'group' ? (
                  <tr key={rowKey(row)} data-testid="cookie-domain-group" className="bg-surface-raised">
                    <th scope="colgroup" colSpan={7} className="px-2 py-1 text-left text-xs font-medium text-fg-muted">
                      <div className="flex items-center justify-between gap-2">
                        <span>{`${row.domain} · ${String(row.count)}`}</span>
                        <Button
                          variant="ghost"
                          data-testid="cookie-delete-domain"
                          onClick={() => {
                            void store().removeDomain(row.domain);
                          }}
                        >
                          {`Delete all for ${row.domain}`}
                        </Button>
                      </div>
                    </th>
                  </tr>
                ) : (
                  <CookieRow
                    key={rowKey(row)}
                    cookie={row.cookie}
                    showValues={showValues}
                    onCommitValue={(value) => {
                      void store().set({ ...row.cookie, value });
                    }}
                    onEdit={() => {
                      setEditing({ cookie: row.cookie });
                    }}
                    onDelete={() => {
                      void store().remove({ name: row.cookie.name, domain: row.cookie.domain, path: row.cookie.path });
                    }}
                  />
                ),
              )}
              {paddingBottom > 0 && <tr aria-hidden="true" style={{ height: paddingBottom }} />}
            </tbody>
          </table>
        </div>
      )}

      {editing !== undefined && (
        <CookieDialog
          open
          cookie={editing.cookie}
          onOpenChange={(open) => {
            if (!open) {
              setEditing(undefined);
            }
          }}
          onSave={(cookie, replaces) => {
            setEditing(undefined);
            void store().set(cookie, replaces);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all cookies?"
        description={`This deletes all ${String(cookies.length)} cookies of this workspace.`}
        confirmLabel="Clear all"
        destructive
        onConfirm={() => {
          setConfirmClear(false);
          void store().clear();
        }}
        testId="cookie-clear-confirm"
        confirmTestId="cookie-clear-confirm-ok"
        cancelTestId="cookie-clear-confirm-cancel"
      />
    </section>
  );
}
