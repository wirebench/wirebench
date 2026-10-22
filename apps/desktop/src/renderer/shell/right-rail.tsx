import { Code2, Folders, PanelRight } from 'lucide-react';
import {
  useEnvironmentDetailsShown,
  setEnvironmentDetailsOpen,
  useOpenEnvironmentId,
} from '../features/environments/environment-details.js';
import {
  setEnvironmentProjectsOpen,
  useEnvironmentProjectsShown,
} from '../features/environments/environment-projects.js';
import { useForwardDetailsShown, useHostDetailsShown } from '../features/ssh/details-shown.js';
import { useForwardsStore } from '../features/ssh/forwarding/forwards-store.js';
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
  // Requests show Code; SSH's icon opens the picked host's details instead, and an environment
  // tab its details.
  const panel = useEditorsStore((state) => rightPanelFor(state));
  const hostDetailsShown = useHostDetailsShown();
  const environmentDetailsShown = useEnvironmentDetailsShown();
  const environmentProjectsShown = useEnvironmentProjectsShown();
  const hasEnvironment = useOpenEnvironmentId() !== undefined;
  // On the Port forwarding view the icon is the picked forward's details instead; host details stay hidden.
  const onForwarding = useHostsStore((state) => state.homeView === 'forwarding');
  const forwardDetailsShown = useForwardDetailsShown();
  const hasForward = useForwardsStore((state) => state.selectedKey !== undefined);

  return (
    <nav
      data-testid="right-rail"
      aria-label="Panels"
      className="flex w-right-rail shrink-0 flex-col items-center gap-1 border-l border-hairline bg-surface-sunken py-2"
    >
      {panel === 'host-details' && onForwarding && (
        <IconButton
          label="Forward details"
          active={forwardDetailsShown}
          disabled={!hasForward}
          data-testid="rail-forward-details"
          aria-pressed={undefined}
          aria-expanded={forwardDetailsShown}
          aria-controls="slide-over"
          onClick={() => {
            useForwardsStore.getState().setDetailsOpen(!forwardDetailsShown);
            // The details belong to the view in the area's first tab: bring it to the front if a terminal is.
            if (!forwardDetailsShown) useEditorsStore.getState().showStart();
          }}
        >
          <PanelRight size={17} aria-hidden="true" />
        </IconButton>
      )}
      {panel === 'host-details' && !onForwarding && (
        <IconButton
          label="Host details"
          active={hostDetailsShown}
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
            setEnvironmentDetailsOpen(!environmentDetailsShown);
          }}
        >
          <PanelRight size={17} aria-hidden="true" />
        </IconButton>
      )}
      {panel === 'environment-details' && (
        // Which projects the environment applies to (#393): its own panel, in the same slide-over.
        <IconButton
          label="Projects"
          active={environmentProjectsShown}
          disabled={!hasEnvironment}
          data-testid="rail-environment-projects"
          aria-pressed={undefined}
          aria-expanded={environmentProjectsShown}
          aria-controls="slide-over"
          onClick={() => {
            setEnvironmentProjectsOpen(!environmentProjectsShown);
          }}
        >
          <Folders size={17} aria-hidden="true" />
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
