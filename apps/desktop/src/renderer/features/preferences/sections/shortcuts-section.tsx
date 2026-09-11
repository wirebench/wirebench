import { ShortcutsEditor } from '../shortcuts-editor.js';
import type { CommandContext } from '../../../lib/commands.js';

export interface ShortcutsSectionProps {
  readonly context: CommandContext;
}

/**
 * Preferences → Shortcuts. A thin wrapper so the section list stays a flat list of sections;
 * the table, the chord recorder and the reset buttons all live in {@link ShortcutsEditor}.
 */
export function ShortcutsSection({ context }: ShortcutsSectionProps) {
  return <ShortcutsEditor context={context} />;
}
