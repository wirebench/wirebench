import {
  ArrowLeftRight,
  KeyRound,
  LayoutPanelLeft,
  Server,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import type { SshHomeView } from './hosts-store.js';

/** What each view of the SSH area's fixed tab is called, and its icon: the tab takes both from the view shown. */
export const SSH_VIEWS: Readonly<Record<SshHomeView, { readonly label: string; readonly icon: LucideIcon }>> = {
  hosts: { label: 'Hosts', icon: Server },
  snippets: { label: 'Snippets', icon: SquareTerminal },
  layouts: { label: 'Layouts', icon: LayoutPanelLeft },
  forwarding: { label: 'Port forwarding', icon: ArrowLeftRight },
  keychain: { label: 'Keychain', icon: KeyRound },
  'known-hosts': { label: 'Known hosts', icon: ShieldCheck },
};
