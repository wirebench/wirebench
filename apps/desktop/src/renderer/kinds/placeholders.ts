/**
 * What the desktop says of a placeholder (kind modules spec §7.2): a container of a kind this run
 * switched off, or of a kind this version does not know. Pure, so the tree builder can use it.
 */
import { KINDS } from '@shared/kinds/kind-module.js';

/** How a kind is named to a person; an unknown kind by its own name. */
export function kindLabel(kind: string): string {
  return KINDS.find((candidate) => candidate.kind === kind)?.label ?? kind;
}

/** Why a placeholder cannot be opened or changed: its row's tooltip and only menu item, and its tab's panel. */
export function placeholderMessage(kind: string, reason: 'unknown-kind' | 'feature-disabled'): string {
  return reason === 'feature-disabled'
    ? `${kindLabel(kind)} is switched off`
    : `This project uses a kind this version of Wirebench does not know (${kind})`;
}
