/**
 * What a webhook node inherits for signing, and the CI name it is offered (webhook-signatures §5).
 * The engine's `signingAlong`, restated for the renderer's flat folder map.
 */
import { folderChainOf } from '../../state/project.js';
import { schemeSummary } from '../webhooks/signature-text.js';
import type { RestFolderWire, WebhookCollectionWire, WebhookSigningWire } from '../../../shared/wire-types.js';

export interface InheritedSigning {
  readonly signing: WebhookSigningWire;
  readonly from: 'folder' | 'collection' | 'default';
  readonly fromName?: string;
}

/** The nearest ancestor folder's own signing, else the collection's, else none. */
export function inheritedSigningOf(
  folders: Readonly<Record<string, RestFolderWire>>,
  parentId: string | undefined,
  collection: Pick<WebhookCollectionWire, 'signing'> | undefined,
): InheritedSigning {
  const chain = folderChainOf(folders, parentId);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const folder = chain[index];
    if (folder?.signing !== undefined) return { signing: folder.signing, from: 'folder', fromName: folder.name };
  }
  return collection?.signing !== undefined
    ? { signing: collection.signing, from: 'collection' }
    : { signing: { mode: 'none' }, from: 'default' };
}

/** `Inherits HMAC of body · … from the folder “Orders”`. */
export function signingSummary(inherited: InheritedSigning): string {
  if (inherited.from === 'default') return 'Inherits None (nothing above sets signing)';
  const what = inherited.signing.mode === 'none' ? 'None' : schemeSummary(inherited.signing.scheme);
  const where = inherited.from === 'folder' ? `the folder “${inherited.fromName ?? ''}”` : 'the Webhooks collection';
  return `Inherits ${what} from ${where}`;
}

/** The project file's `envName` rule, which main checks again (`webhook-signing-invalid`). */
const CI_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * A CI name from a node's name: upper snake case (`Order paid` → `ORDER_PAID`), `WEBHOOK_` in front
 * when it would start with a digit, `WEBHOOK` when nothing is left — the project file's `envName`
 * rule, `^[A-Z][A-Z0-9_]*$`.
 */
export function ciNameOf(name: string): string {
  const snake = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (snake === '') return 'WEBHOOK';
  return CI_NAME_PATTERN.test(snake) ? snake : `WEBHOOK_${snake}`;
}

/** Why a typed CI name would be refused; `undefined` when it would be kept (an empty one means none). */
export function ciNameProblemOf(name: string): string | undefined {
  return name === '' || CI_NAME_PATTERN.test(name)
    ? undefined
    : 'A CI name is upper-case letters, digits and _, starting with a letter.';
}
