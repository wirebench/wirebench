/**
 * Settings → Plugins (phase 7 spec §9, ADR-0031): the plugins installed for this user, what each
 * contributes and which origins it may reach, and installing or removing one. A plugin is picked with
 * the Open dialog, read by main, and shown here before anything is written; installing it is a second,
 * explicit click. Nothing a plugin ships runs in this window: the rows are what its manifest declares.
 * A change applies at the next start, and the row says so.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { SettingsGroup, SettingsItem } from '../../../components/settings-grid.js';
import { showToast } from '../../../components/toast.js';
import { ipc } from '../../../state/ipc-client.js';
import type { PluginRowWire, PluginsListResponse, PluginsStageResponse } from '../../../../shared/plugins-wire.js';

function Contributions({ plugin }: { readonly plugin: PluginRowWire }) {
  const lines = [
    ...plugin.importers.map(
      (entry) => `Importer: ${entry.title}${entry.extensions.length > 0 ? ` (${entry.extensions.join(', ')})` : ''}`,
    ),
    ...plugin.reporters.map((entry) => `Reporter: ${entry.title} (${entry.id})`),
    ...plugin.codeGenerators.map((entry) => `Code generator: ${entry.title}`),
  ];
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
      <li data-testid={`plugin-network-${plugin.id}`}>
        Network: {plugin.network.length > 0 ? plugin.network.join(', ') : 'none'}
      </li>
    </ul>
  );
}

export function PluginsSection() {
  const [list, setList] = useState<PluginsListResponse | undefined>(undefined);
  const [staged, setStaged] = useState<PluginsStageResponse | undefined>(undefined);
  const [removing, setRemoving] = useState<PluginRowWire | undefined>(undefined);
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set());

  const reload = useCallback(async () => {
    const result = await Promise.resolve()
      .then(() => ipc().plugins.list(undefined))
      .catch(() => undefined);
    if (result?.ok === true) setList(result.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pick = async (kind: 'folder' | 'file') => {
    const picked =
      kind === 'folder'
        ? await ipc().dialogs.openFolder({ title: 'Install Plugin from Folder' })
        : await ipc().dialogs.openFile({
            title: 'Install Plugin from File',
            filters: [{ name: 'Plugin archive (*.tgz)', extensions: ['tgz'] }],
          });
    if (!picked.ok || picked.value.path === undefined) return;
    const stagedResult = await ipc().plugins.stage({ path: picked.value.path });
    if (!stagedResult.ok) {
      showToast(stagedResult.error.message);
      return;
    }
    setStaged(stagedResult.value);
  };

  const install = async () => {
    const plugin = staged;
    setStaged(undefined);
    if (plugin === undefined) return;
    const result = await ipc().plugins.install({ token: plugin.token });
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    setChanged((before) => new Set([...before, result.value.id]));
    showToast(`Installed ${plugin.plugin.name}. It loads the next time Wirebench starts.`);
    await reload();
  };

  const remove = async () => {
    const plugin = removing;
    setRemoving(undefined);
    if (plugin === undefined) return;
    const result = await ipc().plugins.remove({ id: plugin.id });
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    setChanged((before) => new Set([...before, plugin.id]));
    showToast(`Removed ${plugin.name}. It is gone the next time Wirebench starts.`);
    await reload();
  };

  const before = staged?.replaces;
  return (
    <>
      <SettingsGroup
        title="Plugins"
        hint="Importers, reporters and code generators you installed. They run in the script sandbox, and only an importer may reach the network origins it lists. A project can never bring one."
      >
        {list === undefined ? (
          <SettingsItem>
            <span className="text-sm text-fg-subtle">Loading…</span>
          </SettingsItem>
        ) : (
          <>
            {list.off && (
              <SettingsItem>
                <span data-testid="plugins-off" className="text-sm text-fg-subtle">
                  Plugins are switched off (Settings → Features → Plugins); none was loaded.
                </span>
              </SettingsItem>
            )}
            {list.plugins.length === 0 && list.skipped.length === 0 && (
              <SettingsItem>
                <span data-testid="plugins-empty" className="text-sm text-fg-subtle">
                  No plugins are installed.
                </span>
              </SettingsItem>
            )}
            {list.plugins.map((plugin) => (
              <SettingsItem key={plugin.id}>
                <div data-testid={`plugin-row-${plugin.id}`} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-fg-default">
                      {plugin.name} <span className="text-fg-subtle">{plugin.version}</span>
                    </div>
                    {plugin.description !== undefined && (
                      <div className="text-xs text-fg-subtle">{plugin.description}</div>
                    )}
                    <Contributions plugin={plugin} />
                    {(changed.has(plugin.id) || !plugin.loaded) && !list.off && (
                      <div className="mt-1 text-xs text-fg-subtle">Applies after restart</div>
                    )}
                  </div>
                  <Button data-testid={`plugin-remove-${plugin.id}`} onClick={() => setRemoving(plugin)}>
                    Remove
                  </Button>
                </div>
              </SettingsItem>
            ))}
            {list.skipped.map((skipped) => (
              <SettingsItem key={`skipped-${skipped.id}`}>
                <div data-testid={`plugin-skipped-${skipped.id}`} className="text-sm text-fg-subtle">
                  {skipped.id}: not loaded. {skipped.message}
                </div>
              </SettingsItem>
            ))}
            <SettingsItem>
              <div className="flex gap-2">
                <Button data-testid="plugin-install-folder" onClick={() => void pick('folder')}>
                  Install from folder…
                </Button>
                <Button data-testid="plugin-install-file" onClick={() => void pick('file')}>
                  Install from file…
                </Button>
              </div>
            </SettingsItem>
          </>
        )}
      </SettingsGroup>
      <ConfirmDialog
        open={staged !== undefined}
        onOpenChange={(open) => {
          if (!open) setStaged(undefined);
        }}
        title={staged !== undefined ? `Install ${staged.plugin.name} ${staged.plugin.version}?` : 'Install plugin?'}
        description={
          staged === undefined ? (
            ''
          ) : (
            <div data-testid="plugin-install-summary">
              {before !== undefined && (
                <p className="mb-1">
                  Replaces version {before.version}
                  {before.network.join(',') !== staged.plugin.network.join(',')
                    ? `, which could reach ${before.network.length > 0 ? before.network.join(', ') : 'no origin'}`
                    : ''}
                  .
                </p>
              )}
              <Contributions plugin={staged.plugin} />
              <p className="mt-2">It runs in the script sandbox and loads the next time Wirebench starts.</p>
            </div>
          )
        }
        confirmLabel="Install"
        onConfirm={() => void install()}
        confirmTestId="plugin-install-confirm"
      />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        title={removing !== undefined ? `Remove ${removing.name}?` : 'Remove plugin?'}
        description="Its files and its record are deleted. Requests and projects are not touched."
        confirmLabel="Remove"
        destructive
        onConfirm={() => void remove()}
        confirmTestId="plugin-remove-confirm"
      />
    </>
  );
}
