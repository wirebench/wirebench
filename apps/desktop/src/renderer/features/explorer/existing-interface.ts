/**
 * Finds the interface a WSDL import would duplicate (#727): one in the target project imported from
 * the same URL or file. Re-importing is how people try to refresh a changed service, so the dialog
 * offers Update Definition… instead of silently adding a second, identical tree.
 *
 * Pasted text has no location to compare, so it never matches. A different URL serving the same
 * target namespace (a staging and a production copy, say) is a legitimate second interface and is
 * not matched either.
 */

import type { ImportSourceWire, InterfaceWire } from '@shared/kinds/soap/wire.js';

/** A file path as forward-slashed and without a leading slash before a drive letter, for comparing. */
function normalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/([A-Za-z]:\/)/, '$1');
}

/** Whether `definitionUrl` records the location `source` names. */
function sameLocation(definitionUrl: string, source: ImportSourceWire): boolean {
  if (source.kind === 'url') {
    return definitionUrl.trim() === source.url.trim();
  }
  if (source.kind === 'file') {
    if (!definitionUrl.startsWith('file:')) {
      return normalPath(definitionUrl) === normalPath(source.path);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(definitionUrl.replace(/^file:\/\/(localhost)?/, ''));
    } catch {
      return false;
    }
    return normalPath(decoded) === normalPath(source.path);
  }
  return false;
}

/** The interface in `projectId` already imported from `source`'s location, if any. */
export function findExistingInterface(
  interfaces: Readonly<Record<string, InterfaceWire>>,
  projectOf: Readonly<Record<string, string>>,
  projectId: string,
  source: ImportSourceWire,
): InterfaceWire | undefined {
  return Object.values(interfaces).find(
    (iface) => projectOf[iface.id] === projectId && sameLocation(iface.definitionUrl, source),
  );
}
