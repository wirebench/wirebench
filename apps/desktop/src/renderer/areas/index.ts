import type { ComponentType } from 'react';
import { Braces, FolderTree, History, Search, ShieldCheck, TerminalSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AreaId, AreaModule } from '@shared/area-module.js';
import { EnvironmentsView } from '../features/environments/environments-view.js';
import { ExplorerView } from '../features/explorer/explorer-view.js';
import { HistoryView } from '../features/history/history-view.js';
import { SearchView } from '../features/search/search-view.js';
import { WssSection } from '../features/wss/wss-section.js';

export interface RendererArea {
  readonly View: ComponentType;
  /** Commands the area owns beyond `view.show*`; called by `registerShellCommands` for enabled areas. */
  readonly registerCommands?: () => void;
}

export const AREA_ICONS: Readonly<Record<AreaModule['rail']['icon'], LucideIcon>> = {
  FolderTree,
  Braces,
  Search,
  History,
  ShieldCheck,
  TerminalSquare,
};

export const RENDERER_AREAS: Readonly<Record<AreaId, RendererArea>> = {
  explorer: { View: ExplorerView },
  environments: { View: EnvironmentsView },
  search: { View: SearchView },
  history: { View: HistoryView },
  wss: { View: WssSection },
};
