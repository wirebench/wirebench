import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { ipc } from '../../state/ipc-client.js';
import type { ShareToServerRequest } from '../../state/workspace.js';
import type { DefaultRoleWire, TeamWire, TeamWorkspaceWire } from '../../../shared/wire-types.js';
import { shareRefusalMessage } from '../sync/sync-codes.js';
import { DEFAULT_ROLES, ROLE_LABELS } from '../team/roles.js';
import { workspaceActions } from './workspace-actions.js';

/** Server workspace names are 1 to 80 characters once trimmed (`teamsNameSchema`, teams-access §3.2). */
const MAX_NAME_LENGTH = 80;

/** The Share dialog's own field style, so the three kinds read as one form. */
const FIELD_CLASS =
  'mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';
const LABEL_CLASS = 'mt-3 block text-sm text-fg-subtle';
const RADIO_LABEL_CLASS = 'flex items-center gap-2 text-sm text-fg-default';

/** Where on the team the workspace goes. */
type Into = 'new' | 'existing';

/** A list the form asks main for: still loading, loaded, or why it could not be. */
type Loaded<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly items: readonly T[] }
  | { readonly state: 'failed'; readonly message: string };

export interface ServerShareFormProps {
  /** The open workspace's name: what a new server workspace is called unless changed. */
  readonly workspaceName: string;
  /** Called once main has shared the workspace; the dialog closes. */
  readonly onShared: () => void;
}

/**
 * *Share this workspace… → Wirebench Server* (server-sync §3.4): the server (when several are signed
 * in) and the team, then either a new server workspace — its name and the team's default role,
 * *Viewer* unless changed (O3) — or an existing empty one the caller can edit (O1), whose name and id
 * the local workspace then takes. Main does everything else. A refusal stays in the form, since
 * choosing again is the answer to most of them.
 */
export function ServerShareForm({ workspaceName, onShared }: ServerShareFormProps) {
  const servers = signedInServers(useAccountStore((state) => state.servers));
  const [url, setUrl] = useState(servers[0]?.url);
  const [teams, setTeams] = useState<Loaded<TeamWire>>({ state: 'loading' });
  const [teamId, setTeamId] = useState<string | undefined>(undefined);
  const [into, setInto] = useState<Into>('new');
  const [name, setName] = useState(workspaceName);
  const [defaultRole, setDefaultRole] = useState<DefaultRoleWire>('viewer');
  const [targets, setTargets] = useState<Loaded<TeamWorkspaceWire>>({ state: 'loading' });
  const [targetId, setTargetId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (url === undefined) {
      return;
    }
    // A reply for a server the user has since switched away from is dropped, not shown.
    let current = true;
    setTeams({ state: 'loading' });
    setTeamId(undefined);
    void ipc()
      .team.list({ url })
      .then((result) => {
        if (!current) {
          return;
        }
        if (result.ok) {
          setTeams({ state: 'ready', items: result.value.teams });
          setTeamId(result.value.teams[0]?.id);
        } else {
          setTeams({ state: 'failed', message: result.error.message });
        }
      });
    return () => {
      current = false;
    };
  }, [url]);

  useEffect(() => {
    if (into !== 'existing' || url === undefined || teamId === undefined) {
      return;
    }
    let current = true;
    setTargets({ state: 'loading' });
    setTargetId(undefined);
    void ipc()
      .workspace.serverTargets({ url, teamId })
      .then((result) => {
        if (!current) {
          return;
        }
        if (result.ok) {
          setTargets({ state: 'ready', items: result.value.workspaces });
          setTargetId(result.value.workspaces[0]?.id);
        } else {
          setTargets({ state: 'failed', message: result.error.message });
        }
      });
    return () => {
      current = false;
    };
  }, [into, url, teamId]);

  const team = teams.state === 'ready' ? teams.items.find((item) => item.id === teamId) : undefined;
  const trimmed = name.trim();
  const target: ShareToServerRequest['target'] | undefined =
    into === 'new'
      ? trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH
        ? { kind: 'new', name: trimmed, defaultRole }
        : undefined
      : targetId === undefined
        ? undefined
        : { kind: 'existing', workspaceId: targetId };
  const complete = url !== undefined && team !== undefined && target !== undefined;

  const submit = async (): Promise<void> => {
    if (url === undefined || team === undefined || target === undefined || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const outcome = await workspaceActions.shareToServer({ url, teamId: team.id, teamName: team.name, target });
    setBusy(false);
    if (outcome === true) {
      onShared();
    } else if (outcome !== false) {
      setError(shareRefusalMessage(outcome));
    }
  };

  return (
    <>
      {servers.length > 1 && (
        <>
          <label className={LABEL_CLASS} htmlFor="share-server">
            Server
          </label>
          <select
            id="share-server"
            data-testid="share-server"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
            className={FIELD_CLASS}
          >
            {servers.map((server) => (
              <option key={server.url} value={server.url}>
                {server.url}
              </option>
            ))}
          </select>
        </>
      )}

      <label className={LABEL_CLASS} htmlFor="share-team">
        Team
      </label>
      {teams.state === 'failed' ? (
        <p role="alert" data-testid="share-team-error" className="mt-1 text-xs text-status-danger">
          {teams.message}
        </p>
      ) : teams.state === 'ready' && teams.items.length === 0 ? (
        <p data-testid="share-team-none" className="mt-1 text-xs text-fg-subtle">
          You are not on a team on this server yet. A server admin can add you to one.
        </p>
      ) : (
        <select
          id="share-team"
          data-testid="share-team"
          disabled={teams.state === 'loading'}
          value={teamId ?? ''}
          onChange={(event) => {
            setTeamId(event.target.value);
          }}
          className={FIELD_CLASS}
        >
          {teams.state === 'ready' &&
            teams.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      )}

      <fieldset className="mt-3 flex flex-col gap-2">
        <legend className="sr-only">Share into</legend>
        <label className={RADIO_LABEL_CLASS}>
          <input
            type="radio"
            name="share-target"
            data-testid="share-target-new"
            checked={into === 'new'}
            onChange={() => {
              setInto('new');
            }}
          />
          A new workspace
        </label>
        <label className={RADIO_LABEL_CLASS}>
          <input
            type="radio"
            name="share-target"
            data-testid="share-target-existing"
            checked={into === 'existing'}
            onChange={() => {
              setInto('existing');
            }}
          />
          An existing empty workspace
        </label>
      </fieldset>

      {into === 'new' ? (
        <>
          <label className={LABEL_CLASS} htmlFor="share-server-name">
            Name on the server
          </label>
          <input
            id="share-server-name"
            data-testid="share-server-name"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className={FIELD_CLASS}
          />
          <label className={LABEL_CLASS} htmlFor="share-default-role">
            Default role for the team
          </label>
          <select
            id="share-default-role"
            data-testid="share-default-role"
            value={defaultRole}
            onChange={(event) => {
              setDefaultRole(event.target.value as DefaultRoleWire);
            }}
            className={FIELD_CLASS}
          >
            {DEFAULT_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </>
      ) : teamId === undefined ? (
        // No team to list targets for: the Team field above already says why (none, or an error).
        teams.state === 'loading' ? (
          <p className="mt-3 text-sm text-fg-subtle">Loading…</p>
        ) : null
      ) : targets.state === 'loading' ? (
        <p className="mt-3 text-sm text-fg-subtle">Loading…</p>
      ) : targets.state === 'failed' ? (
        <p role="alert" data-testid="share-existing-error" className="mt-3 text-xs text-status-danger">
          {targets.message}
        </p>
      ) : targets.items.length === 0 ? (
        <p data-testid="share-existing-empty" className="mt-3 text-sm text-fg-subtle">
          This team has no empty workspace you can edit. A team admin can create one in Manage teams.
        </p>
      ) : (
        <>
          <label className={LABEL_CLASS} htmlFor="share-existing">
            Workspace
          </label>
          <select
            id="share-existing"
            data-testid="share-existing"
            value={targetId ?? ''}
            onChange={(event) => {
              setTargetId(event.target.value);
            }}
            className={FIELD_CLASS}
          >
            {targets.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-fg-subtle">This workspace takes the server workspace's name.</p>
        </>
      )}

      {error !== undefined && (
        <p role="alert" data-testid="share-server-error" className="mt-3 text-xs text-status-danger">
          {error}
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Dialog.Close asChild>
          <Button>Cancel</Button>
        </Dialog.Close>
        <Button
          data-testid="share-confirm"
          variant="primary"
          disabled={!complete || busy}
          onClick={() => {
            void submit();
          }}
        >
          {busy ? 'Sharing…' : 'Share'}
        </Button>
      </div>
    </>
  );
}
