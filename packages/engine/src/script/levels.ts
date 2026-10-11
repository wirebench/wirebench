/**
 * The levels above a request whose scripts run around its own (#334), built from a container and
 * the folders a request sits in. Kept apart from `request-scripts.ts`, which reaches the protocol
 * registry: every protocol's run facet imports this, and must not import the registry back.
 */
import type { RequestScripts } from './model.js';
import type { ScriptLevel } from './request-scripts.js';

/**
 * The levels of a container and the folders a request sits in (#334), outermost first: the
 * container's, as `kind`, then each folder's, its file stem the folders' slugs then `folder`. Only
 * those with a `scripts` key.
 */
export function containerScriptLevels(
  container: { readonly name: string; readonly scripts?: RequestScripts },
  kind: 'api' | 'interface',
  chain: readonly { readonly name: string; readonly slug: string; readonly scripts?: RequestScripts }[] = [],
): ScriptLevel[] {
  const levels: ScriptLevel[] = [];
  if (container.scripts !== undefined) {
    levels.push({ level: kind, name: container.name, stem: kind, scripts: container.scripts });
  }
  chain.forEach((folder, index) => {
    if (folder.scripts === undefined) return;
    const slugs = chain.slice(0, index + 1).map((each) => each.slug);
    levels.push({ level: 'folder', name: folder.name, stem: [...slugs, 'folder'].join('/'), scripts: folder.scripts });
  });
  return levels;
}
