/**
 * Script edits not yet in main (#63). A script editor writes after a pause in typing, and a send or
 * a save made inside that pause must not go out without it: main's copy of the request is what is
 * sent and saved. So every open script editor registers a flush here, and the send and save
 * actions wait for {@link flushScriptEdits} before they start.
 *
 * A webhook item's **Signing** tab registers here too: a signing secret typed but not saved on its
 * own is stored, and its ref staged, before the send or save reads the request.
 */

const flushes = new Set<() => Promise<void>>();

/** Registers one editor's flush; returns the unregister. */
export function registerScriptEditFlush(flush: () => Promise<void>): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Whether any script editor is open, so a caller with nothing to wait for need not await. */
export function hasScriptEditors(): boolean {
  return flushes.size > 0;
}

/** Writes every pending script edit, and waits until main has each one. A failed write is not rethrown here. */
export async function flushScriptEdits(): Promise<void> {
  if (flushes.size === 0) {
    return;
  }
  await Promise.all([...flushes].map((flush) => flush().catch(() => undefined)));
}
