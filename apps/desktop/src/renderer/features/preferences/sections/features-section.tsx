import { useEffect, useState } from 'react';
import { BooleanSetting, SettingsGroup, SettingsItem } from '../../../components/settings-grid.js';
import { ipc } from '../../../state/ipc-client.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import type { AppFeaturesWire, FeatureStateWire } from '@shared/wire-base.js';
import type { SectionProps } from './section-props.js';

/** The groups the rows sit in (phase 4 spec §4.3), by feature id; anything else lands in Other. */
const GROUPS: readonly { readonly title: string; readonly ids: readonly string[] }[] = [
  { title: 'Protocols', ids: ['soap', 'rest', 'graphql', 'grpc', 'websocket', 'mcp'] },
  { title: 'Automation', ids: ['scripts', 'sequences', 'webhooks'] },
  { title: 'Team', ids: ['server-sync', 'team-secrets', 'mcp-server'] },
  // Each installed plugin's `plugin:<id>` joins this group after the switch that covers them all.
  { title: 'Plugins', ids: ['plugins'] },
];

/** The rows as main resolved them for the open workspace; `undefined` until it answered. */
function useFeatureStates(): AppFeaturesWire | undefined {
  const workspaceId = useWorkspaceStore((state) => state.workspace?.id);
  const [states, setStates] = useState<AppFeaturesWire | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void ipc()
      .app.features(undefined)
      .then((result) => {
        if (!cancelled && result.ok) setStates(result.value);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  return states;
}

function groupsOf(
  states: readonly FeatureStateWire[],
): readonly { readonly title: string; readonly rows: FeatureStateWire[] }[] {
  const byId = new Map(states.map((state) => [state.id, state]));
  const placed = new Set<string>();
  const groups = GROUPS.map((group) => ({
    title: group.title,
    rows: group.ids.flatMap((id) => {
      const state = byId.get(id);
      if (state === undefined) return [];
      placed.add(id);
      return [state];
    }),
  }));
  const plugins = groups.find((group) => group.title === 'Plugins');
  for (const state of states) {
    if (!state.id.startsWith('plugin:') || placed.has(state.id)) continue;
    plugins?.rows.push(state);
    placed.add(state.id);
  }
  const other = states.filter((state) => !placed.has(state.id));
  return [...groups, ...(other.length > 0 ? [{ title: 'Other', rows: other }] : [])].filter(
    (group) => group.rows.length > 0,
  );
}

/**
 * Settings → Features (phase 4 spec §4.3): one row per switch, grouped, with its stage, the toggle
 * bound to `preferences.features[id]`, and a line saying why it is off when it is: the open
 * workspace's team policy (the toggle is then disabled, ADR-0029), or a feature it requires. A
 * toggle applies at the next start, and the row says so until then.
 */
export function FeaturesSection({ preferences, update }: SectionProps) {
  const answer = useFeatureStates();
  if (answer === undefined) {
    return (
      <SettingsGroup title="Features">
        <SettingsItem>
          <span className="text-sm text-fg-subtle">Loading…</span>
        </SettingsItem>
      </SettingsGroup>
    );
  }
  const titles = new Map([...answer.states, ...(answer.areas ?? [])].map((state) => [state.id, state.title]));
  const policyWorkspace = answer.policy?.workspace;
  const areas = answer.areas ?? [];
  return (
    <>
      {groupsOf(answer.states).map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.rows.map((state) => {
            // What the run started with is the preference as main read it (in a development build,
            // WIREBENCH_FEATURES laid over the file); a file that is silent shows that, not the default.
            const startedWith = state.preference ?? state.default;
            const wanted = preferences.features[state.id] ?? startedWith;
            const notes: string[] = [];
            if (state.policy && policyWorkspace !== undefined) {
              notes.push(`Off by team policy for ${policyWorkspace}`);
            }
            if (state.reason?.by === 'requires') {
              notes.push(`Requires ${titles.get(state.reason.feature) ?? state.reason.feature}`);
            }
            if (wanted !== startedWith) {
              notes.push('Applies after restart');
            }
            return (
              <BooleanSetting
                key={state.id}
                label={state.title}
                setting={`features.${state.id}`}
                testId={`feature-switch-${state.id}`}
                value={wanted}
                disabled={state.policy}
                onChange={(value) => {
                  update({ features: { [state.id]: value } });
                }}
                {...(state.stage === 'experimental'
                  ? {
                      aside: (
                        <span
                          data-testid={`feature-stage-${state.id}`}
                          className="rounded bg-accent-muted px-1.5 py-0.5 text-xs font-medium text-accent"
                        >
                          Experimental
                        </span>
                      ),
                    }
                  : {})}
                {...(notes.length > 0
                  ? { note: <span data-testid={`feature-note-${state.id}`}>{notes.join(' · ')}</span> }
                  : {})}
              />
            );
          })}
        </SettingsGroup>
      ))}
      {areas.length > 0 && (
        <SettingsGroup
          title="Areas"
          hint="Switched by your organisation's policy file; there is no per-machine setting."
        >
          {areas.map((state) => {
            // An area has no preference (#360): the row reports what this run resolved and cannot be changed
            // here. The managed policy is the "policy" level of that resolution, WIREBENCH_AREAS the "preference".
            const notes: string[] = [];
            if (state.policy) {
              notes.push('Set by your organisation');
            } else if (state.reason?.by === 'preference') {
              notes.push('Off by WIREBENCH_AREAS for this run');
            }
            if (state.reason?.by === 'requires') {
              notes.push(`Requires ${titles.get(state.reason.feature) ?? state.reason.feature}`);
            }
            return (
              <BooleanSetting
                key={state.id}
                label={state.title}
                testId={`area-switch-${state.id}`}
                value={state.enabled}
                disabled
                locked={state.policy}
                onChange={() => undefined}
                {...(notes.length > 0
                  ? { note: <span data-testid={`area-note-${state.id}`}>{notes.join(' · ')}</span> }
                  : {})}
              />
            );
          })}
        </SettingsGroup>
      )}
    </>
  );
}
