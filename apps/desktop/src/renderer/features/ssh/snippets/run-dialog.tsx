/**
 * The run dialog (spec D9.4): the variables form, the targets (open terminals to tick, then hosts, groups
 * and tags as chips showing the hosts they expand to), the script as it will be typed (secrets as `••••`,
 * from main), the note on secrets and every protected host named with where it comes from. In `variables`
 * mode (the terminal in front, nothing else to ask) it is the variables form alone.
 */
import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { Plus, ShieldAlert, X } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { showToast } from '../../../components/toast.js';
import type { ResolvedHostWire } from '../../../../shared/ssh-wire.js';
import { ipc } from '../../../state/ipc-client.js';
import { flattenGroups, useHostsStore } from '../hosts-store.js';
import type { HostTarget, OpenTerminal, RunRequest } from './run.js';
import {
  closeRunDialog,
  expandTargets,
  openTerminals,
  runInTerminal,
  runOnTargets,
  runSummary,
  showTerminal,
  useRunDialogStore,
} from './run.js';
import { lastTargets, lastValues } from './snippets-prefs.js';
import { useSnippetsStore } from './snippets-store.js';
import { VariablesForm, anyInvalid, initialValues } from './variables-form.js';

export const SECRET_NOTE = 'Typed with a leading space so most shells keep it out of history; hidden on screen';

/** How long the values must stay still before the preview is asked for again. */
const PREVIEW_DEBOUNCE_MS = 150;

export function SnippetRunDialog() {
  const request = useRunDialogStore((s) => s.request);
  // Keyed, so each run starts from its own values and terminal.
  return (
    <Dialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) closeRunDialog();
      }}
    >
      {request !== null && <RunDialogBody key={`${request.snippetId}:${String(request.enter)}`} request={request} />}
    </Dialog.Root>
  );
}

/** A chip's words: what the target is called, and how the picker lists it. */
function targetLabel(
  target: HostTarget,
  groupNames: ReadonlyMap<string, string>,
  hosts: readonly ResolvedHostWire[],
): string {
  if (target.kind === 'tag') return `#${target.id}`;
  if (target.kind === 'group') return groupNames.get(target.id) ?? target.id;
  return hosts.find((h) => h.id === target.id)?.name ?? target.id;
}

const sameTarget = (a: HostTarget, b: HostTarget): boolean => a.kind === b.kind && a.id === b.id;

/** Where a protected host's flag comes from, for the warning: "(from Production)" or nothing for the host itself. */
function protectedLine(host: ResolvedHostWire, groupNames: ReadonlyMap<string, string>): string {
  const from = host.protected.from;
  const group = typeof from === 'object' ? (groupNames.get(from.group) ?? from.group) : undefined;
  return group === undefined ? `${host.name} is protected` : `${host.name} is protected (from ${group})`;
}

function RunDialogBody({ request }: { readonly request: RunRequest }) {
  const item = useSnippetsStore((s) => s.snippets.find((x) => x.id === request.snippetId));
  const file = useHostsStore((s) => s.file);
  const resolved = useHostsStore((s) => s.resolved);
  const [terminals] = useState<OpenTerminal[]>(() => openTerminals());
  const [hostTargets, setHostTargets] = useState<readonly HostTarget[]>(() => lastTargets(request.snippetId));
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => {
    const first = request.tabId ?? (hostTargets.length === 0 ? terminals[0]?.tabId : undefined);
    return new Set(first === undefined ? [] : [first]);
  });
  const [picking, setPicking] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialValues(item?.variables ?? [], lastValues(request.snippetId)),
  );
  const [preview, setPreview] = useState<{ text?: string; error?: string }>({});
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const full = request.mode === 'dialog';
  const insert = request.enter === false;

  useEffect(() => {
    if (!full || item === undefined || anyInvalid(values)) return;
    let current = true;
    const timer = setTimeout(() => {
      void ipc()
        .ssh.previewSnippet({ snippetId: item.id, values })
        .then((answer) => {
          if (!current) return;
          setPreview(answer.ok ? { text: answer.value.text } : { error: answer.error.message });
        })
        .catch(() => undefined); // the preview stays as it was; the run itself still works
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [full, item, values]);

  const groupNames = useMemo(
    () => new Map(flattenGroups(file).map(({ group }) => [group.id, group.name] as const)),
    [file],
  );
  const chosenTerminals = terminals.filter((t) => ticked.has(t.tabId));
  // Every host the run touches, each once: the ticked terminals' hosts, then the chips' hosts.
  const targetHosts = (() => {
    const ids = new Set(chosenTerminals.map((t) => t.hostId));
    const out: { id: string; host: ResolvedHostWire | undefined; label: string }[] = chosenTerminals.map((t) => ({
      id: t.hostId,
      host: resolved.find((h) => h.id === t.hostId),
      label: t.label,
    }));
    for (const host of expandTargets(hostTargets, resolved)) {
      if (ids.has(host.id)) continue;
      ids.add(host.id);
      out.push({ id: host.id, host, label: host.name });
    }
    return out;
  })();
  const count = targetHosts.length;
  const verb = insert ? 'Insert' : 'Run';
  const label = count > 1 ? `${verb} on ${String(count)} hosts` : verb;
  const canRun = item !== undefined && count > 0 && !anyInvalid(values) && !running;
  const onlyTerminal = hostTargets.length === 0 && chosenTerminals.length === 1 ? chosenTerminals[0] : undefined;

  const submit = async (): Promise<void> => {
    if (item === undefined || !canRun) return;
    setError(undefined);
    if (onlyTerminal !== undefined) {
      // One terminal: a refusal stays in the dialog, so the user can fix the values and run again.
      setRunning(true);
      try {
        await runInTerminal(onlyTerminal.tabId, item, values, insert ? { enter: false } : {});
        closeRunDialog();
        showTerminal(onlyTerminal.tabId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRunning(false);
      }
      return;
    }
    // Several hosts: the dialog goes, as a host may need the trust prompt or a sign-in; one toast says how it went.
    closeRunDialog();
    const terminalTargets = chosenTerminals.map((t) => ({
      kind: 'terminal' as const,
      tabId: t.tabId,
      hostId: t.hostId,
    }));
    runOnTargets(item, values, terminalTargets, hostTargets, insert ? { enter: false } : {})
      .then((report) => {
        showToast(runSummary(report));
      })
      .catch((cause: unknown) => {
        showToast(`${item.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
  };

  const protectedHosts = targetHosts.flatMap((t) => (t.host?.protected.value === true ? [t.host] : []));
  const tags = useMemo(() => [...new Set(resolved.flatMap((h) => h.tags))].sort(), [resolved]);
  const choices: { target: HostTarget; text: string; value: string }[] = [
    ...flattenGroups(file).map(({ group }) => ({
      target: { kind: 'group' as const, id: group.id },
      text: `Group ${group.name}`,
      value: `group ${group.name} ${group.id}`,
    })),
    ...tags.map((tag) => ({ target: { kind: 'tag' as const, id: tag }, text: `Tag ${tag}`, value: `tag ${tag}` })),
    ...resolved.map((h) => ({
      target: { kind: 'host' as const, id: h.id },
      text: `Host ${h.name}`,
      value: ['host', h.name, h.address, ...h.tags, h.id].join(' '),
    })),
  ].filter((c) => !hostTargets.some((t) => sameTarget(t, c.target)));

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 bg-black/40" />
      <Dialog.Content
        data-testid="snippet-run-dialog"
        onEscapeKeyDown={(e) => {
          if (!picking) return;
          e.preventDefault();
          setPicking(false);
        }}
        className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[28rem] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-md bg-surface-raised p-4 shadow-lg"
      >
        <Dialog.Title className="text-md font-medium text-fg-default">
          {item === undefined ? 'Snippet' : `${verb} ${item.name}`}
        </Dialog.Title>
        <Dialog.Description className="sr-only">
          The values, the hosts to run on and the script as it will be typed.
        </Dialog.Description>
        {item === undefined ? (
          <p role="alert" className="text-sm text-fg-default">
            This snippet is no longer in snippets.yaml.
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <VariablesForm
              variables={item.variables}
              values={values}
              onChange={(name, value) => {
                setValues((current) => ({ ...current, [name]: value }));
              }}
            />
            {full && (
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-xs font-medium text-fg-muted">Terminals</legend>
                {terminals.length === 0 ? (
                  <p className="text-sm text-fg-subtle">No terminal is connected.</p>
                ) : (
                  terminals.map((t) => (
                    <label key={t.tabId} className="flex items-center gap-2 text-sm text-fg-default">
                      <input
                        type="checkbox"
                        checked={ticked.has(t.tabId)}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          setTicked((current) => {
                            const next = new Set(current);
                            if (on) next.add(t.tabId);
                            else next.delete(t.tabId);
                            return next;
                          });
                        }}
                      />
                      {t.label}
                    </label>
                  ))
                )}
              </fieldset>
            )}
            {full && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-fg-muted">Hosts</span>
                {hostTargets.map((target) => {
                  const name = targetLabel(target, groupNames, resolved);
                  const expands = expandTargets([target], resolved).map((h) => h.name);
                  return (
                    <span
                      key={`${target.kind}:${target.id}`}
                      data-testid="snippet-run-chip"
                      className="flex items-center gap-2 rounded border border-hairline px-2 py-0.5 text-sm text-fg-default"
                    >
                      <span className="font-medium">{name}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
                        {expands.length === 0 ? 'no hosts' : expands.join(', ')}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${name}`}
                        className="text-fg-subtle hover:text-fg-default"
                        onClick={() => {
                          setHostTargets((current) => current.filter((t) => !sameTarget(t, target)));
                        }}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </span>
                  );
                })}
                {picking ? (
                  <Command loop label="Hosts, groups and tags" className="rounded border border-hairline">
                    <Command.Input
                      autoFocus
                      data-testid="snippet-run-target-input"
                      placeholder="Host, group or tag"
                      className="h-8 w-full border-b border-hairline bg-transparent px-2 text-sm text-fg-default outline-none placeholder:text-fg-faint"
                      onKeyDown={(e) => {
                        if (e.key !== 'Escape') return;
                        e.preventDefault();
                        e.stopPropagation();
                        setPicking(false);
                      }}
                    />
                    <Command.List className="max-h-40 overflow-auto p-1">
                      <Command.Empty className="px-2 py-3 text-center text-sm text-fg-subtle">
                        Nothing matches.
                      </Command.Empty>
                      {choices.map((choice) => (
                        <Command.Item
                          key={`${choice.target.kind}:${choice.target.id}`}
                          value={choice.value}
                          aria-label={choice.text}
                          onSelect={() => {
                            setHostTargets((current) => [...current, choice.target]);
                            setPicking(false);
                          }}
                          className="cursor-default rounded px-2 py-1 text-sm text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
                        >
                          {choice.text}
                        </Command.Item>
                      ))}
                    </Command.List>
                  </Command>
                ) : (
                  <Button
                    onClick={() => {
                      setPicking(true);
                    }}
                  >
                    <Plus size={12} aria-hidden="true" />
                    Add host, group or tag
                  </Button>
                )}
              </div>
            )}
            {full &&
              protectedHosts.map((host) => (
                <p
                  key={host.id}
                  data-testid="snippet-run-protected"
                  className="flex items-center gap-2 rounded border border-status-danger px-2 py-1 text-sm text-fg-default"
                >
                  <ShieldAlert size={14} aria-hidden="true" />
                  {protectedLine(host, groupNames)}
                </p>
              ))}
            {full && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-fg-muted">Script</span>
                <pre
                  data-testid="snippet-run-preview"
                  className="max-h-48 overflow-auto rounded border border-hairline bg-surface-base px-2 py-1 font-mono text-xs whitespace-pre-wrap text-fg-default"
                >
                  {preview.text ?? item.firstLine}
                </pre>
                {preview.error !== undefined && <span className="text-xs text-status-danger">{preview.error}</span>}
              </div>
            )}
            {full && item.secrets.length > 0 && <p className="text-xs text-fg-subtle">{SECRET_NOTE}</p>}
            {error !== undefined && (
              <p role="alert" className="rounded border border-status-danger px-2 py-1 text-sm text-fg-default">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={closeRunDialog}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={!canRun}>
                {label}
              </Button>
            </div>
          </form>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  );
}
