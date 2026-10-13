/**
 * What each mounted terminal pane's xterm reports about the remote program, for code outside the pane: a
 * snippet run frames its text as a bracketed paste only when the shell turned that mode on.
 */
const modes = new Map<string, () => boolean>();

/** Called by a pane while its terminal lives; the returned function forgets it. */
export function trackPaneModes(paneId: string, bracketedPasteMode: () => boolean): () => void {
  modes.set(paneId, bracketedPasteMode);
  return () => {
    if (modes.get(paneId) === bracketedPasteMode) modes.delete(paneId);
  };
}

/** Whether the pane's remote program turned bracketed paste on; `false` for a pane not mounted. */
export function bracketedPaste(paneId: string): boolean {
  return modes.get(paneId)?.() ?? false;
}
