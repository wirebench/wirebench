import { Code2, PanelRight } from 'lucide-react';
import {
  useEnvironmentDetailsShown,
  useEnvironmentDetailsStore,
  useOpenEnvironmentId,
} from '../features/environments/environment-details.js';
import { useHostDetailsShown } from '../features/ssh/host-details.js';
import { useHostsStore } from '../features/ssh/hosts-store.js';
import { useEditorsStore } from '../state/editors.js';
import { shortcutFor } from '../lib/keybindings.js';
import type { Platform } from '../lib/platform.js';
import { IconButton } from '../components/icon-button.js';
import { useUiStore } from '../state/ui.js';
import { rightPanelFor } from './right-panel.js';

/**
 * The right rail: a fixed-width strip that replaces the old Details panel's permanent presence.
 * Its one icon today opens the Code slide-over; Task 9 adds this rail's own collapse affordance.
 */
export function RightRail({ platform }: { readonly platform: Platform }) {
  const open = useUiStore((state) => state.slideOver.open);
  const toggleCode = useUiStore((state) => state.toggleCode);
  // Only the areas with requests show Code; SSH's icon opens the picked host's details instead,
  // and Environments' the open environment's details.
  const panel = useEditorsStore((state) => rightPanelFor(state.displayedSet));
  const hostDetailsShown = useHostDetailsShown();
  const hasHost = useHostsStore((state) => state.selectedHostId !== undefined);
  const environmentDetailsShown = useEnvironmentDetailsShown();
  const hasEnvironment = useOpenEnvironmentId() !== undefined;

  return (
    <nav
      data-testid="right-rail"
      aria-label="Panels"
      className="flex w-right-rail shrink-0 flex-col items-center gap-1 border-l border-hairline bg-surface-sunken py-2"
    >
      {panel === 'host-details' && (
        <IconButton
          label="Host details"
          active={hostDetailsShown}
          disabled={!hasHost}
          data-testid="rail-host-details"
          aria-pressed={undefined}
          aria-expanded={hostDetailsShown}
          aria-controls="slide-over"
          onClick={() => {
            const hosts = useHostsStore.getState();
            hosts.setDetailsOpen(!hostDetailsShown);
            // The details belong to the Hosts tab: bring it to the front if a terminal is.
            if (!hostDetailsShown) useEditorsStore.getState().showStart();
            if (!hostDetailsShown) hosts.setHomeView('hosts');
          }}
        >
          <PanelRight size={17} aria-hidden="true" />
        </IconButton>
      )}
      {panel === 'environment-details' && (
        <IconButton
          label="Environment details"
          active={environmentDetailsShown}
          disabled={!hasEnvironment}
          data-testid="rail-environment-details"
          aria-pressed={undefined}
          aria-expanded={environmentDetailsShown}
          aria-controls="slide-over"
          onClick={() => {
            useEnvironmentDetailsStore.getState().setOpen(!environmentDetailsShown);
          }}
        >
          <PanelRight size={17} aria-hidden="true" />
        </IconButton>
      )}
      {panel === 'code' && (
        <IconButton
          label="Code"
          shortcut={shortcutFor('view.toggleCode', platform)}
          active={open}
          data-testid="rail-code"
          aria-pressed={undefined}
          aria-expanded={open}
          aria-controls="slide-over"
          onClick={() => {
            toggleCode();
          }}
        >
          <Code2 size={17} aria-hidden="true" />
        </IconButton>
      )}
    </nav>
  );
}
