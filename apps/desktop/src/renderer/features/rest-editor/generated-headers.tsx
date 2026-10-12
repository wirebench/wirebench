/**
 * The Headers tab's Generated section: every header the send adds on the request's behalf, with
 * where it comes from, before anything is sent (spec `2026-10-11-generated-headers-preview-design.md`).
 *
 * The rows come from main (`request.restHeaders`), which resolves the request as its send does, so
 * what is listed is what goes on the wire. A switch leaves a header out (the request's
 * `omitHeaders`); Override adds a typed header of the same name, which then wins. What the
 * connection or a credential's handshake adds is listed read-only.
 */
import { useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { useCurrentValuesStore } from '../../state/current-values.js';
import { ipc } from '../../state/ipc-client.js';
import { restDraftPatch } from '../../state/project.js';
import { useSecretsVisibilityStore } from '../../state/secrets-visibility.js';
import { useActiveEnvironmentIdFor } from '../../state/workspace.js';
import type {
  RestHeaderRowWire,
  RestRequestPatchWire,
  RestRequestWire,
  RestSettingsWire,
} from '../../../shared/kinds/rest/wire.js';

/** How long the section waits after the last edit before asking main again. */
const PREVIEW_DEBOUNCE_MS = 250;

const SOURCE_LABEL: Readonly<Record<RestHeaderRowWire['source'], string>> = {
  preference: 'Preferences',
  auth: 'Auth',
  body: 'Body',
  cookie: 'Cookie jar',
  typed: 'Headers',
  transport: 'Connection',
  handshake: 'Auth handshake',
};

/** Why a row cannot be switched off or overridden here; undefined when it can. */
function readOnlyReason(row: RestHeaderRowWire): string | undefined {
  switch (row.source) {
    case 'transport':
      return 'Set by the connection for every request.';
    case 'handshake':
      return "Sent after the server's challenge. Set Auth to None to stop it.";
    default:
      return undefined;
  }
}

/** What the row's state means, when it is not simply sent. */
function stateNote(row: RestHeaderRowWire): string | undefined {
  switch (row.state) {
    case 'overridden':
      return 'Replaced by a header of the same name.';
    case 'omitted':
      return 'Not sent.';
    case 'merged':
      return 'Combined with your Cookie header; yours wins on the same name.';
    default:
      return undefined;
  }
}

/** `names` with `name` added or removed, case-insensitively. */
function toggled(names: readonly string[], name: string, omit: boolean): string[] {
  const rest = names.filter((other) => other.toLowerCase() !== name.toLowerCase());
  return omit ? [...rest, name] : rest;
}

export interface GeneratedHeadersProps {
  readonly request: RestRequestWire;
  readonly onChange: (patch: RestRequestPatchWire) => void;
}

/** The Generated section, for a REST request. Shows nothing until main has answered. */
export function GeneratedHeaders({ request, onChange }: GeneratedHeadersProps) {
  const requestId = request.id;
  const activeEnvironment = useActiveEnvironmentIdFor(requestId);
  const currentValues = useCurrentValuesStore((state) => state.byScope);
  const showSecrets = useSecretsVisibilityStore((state) => state.show);
  const [rows, setRows] = useState<readonly RestHeaderRowWire[] | undefined>(undefined);
  const [notes, setNotes] = useState<readonly string[]>([]);

  useEffect(() => {
    // Debounced because it follows every keystroke; the last reply wins.
    let cancelled = false;
    const timer = setTimeout(() => {
      const draft = restDraftPatch(requestId);
      void ipc()
        .request.restHeaders({ requestId, ...(draft !== undefined ? { draft } : {}) })
        .then((result) => {
          if (cancelled || !result.ok) return;
          setRows(result.value.headers.filter((row) => row.source !== 'typed'));
          setNotes(result.value.notes ?? []);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [requestId, request, activeEnvironment, currentValues, showSecrets]);

  if (rows === undefined || (rows.length === 0 && notes.length === 0)) return null;

  const settings: RestSettingsWire = request.settings;
  const omitted = settings.omitHeaders ?? [];
  const setOmitted = (name: string, omit: boolean): void => {
    const next = toggled(omitted, name, omit);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
    const { omitHeaders: _previous, ...rest } = settings;
    onChange({ settings: next.length > 0 ? { ...rest, omitHeaders: next } : rest });
  };
  const override = (row: RestHeaderRowWire): void => {
    // A masked value is not the value: the typed row starts empty rather than holding the marker.
    onChange({
      headers: [...request.headers, { name: row.name, value: row.masked === true ? '' : row.value, enabled: true }],
    });
  };

  return (
    <section aria-label="Generated headers" data-testid="rest-generated-headers" className="mt-3 flex flex-col gap-1">
      <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Generated</h3>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map((row, index) => {
            const reason = readOnlyReason(row);
            const note = stateNote(row);
            return (
              <tr
                key={`${row.name}-${row.source}-${String(index)}`}
                data-testid="rest-generated-header"
                data-state={row.state}
                className="border-b border-hairline align-top"
              >
                <td className="w-8 px-2 py-1">
                  {reason === undefined && (
                    <input
                      type="checkbox"
                      aria-label={`Send ${row.name}`}
                      checked={row.state !== 'omitted'}
                      disabled={row.state === 'overridden'}
                      onChange={(event) => {
                        setOmitted(row.name, !event.target.checked);
                      }}
                    />
                  )}
                </td>
                <td
                  className={`px-2 py-1 font-mono ${row.state === 'sent' || row.state === 'merged' ? 'text-fg-default' : 'text-fg-subtle line-through'}`}
                >
                  {row.name}
                </td>
                <td className="px-2 py-1 font-mono [overflow-wrap:anywhere] text-fg-muted">{row.value}</td>
                <td className="px-2 py-1 text-xs whitespace-nowrap text-fg-subtle">{SOURCE_LABEL[row.source]}</td>
                <td className="px-2 py-1 text-xs text-fg-subtle">
                  {reason ?? note}
                  {reason === undefined && row.state !== 'overridden' && (
                    <Button
                      variant="ghost"
                      className="ml-1"
                      aria-label={`Override ${row.name}`}
                      onClick={() => {
                        override(row);
                      }}
                    >
                      Override
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {notes.map((text) => (
        <p key={text} className="text-xs text-fg-subtle">
          {text}
        </p>
      ))}
    </section>
  );
}
