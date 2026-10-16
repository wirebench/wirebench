import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type ElectronApplication } from '@playwright/test';

/**
 * The system clipboard is the one thing every app instance in a run shares: each spec gets its
 * own Electron, profile and server, but the macOS pasteboard, the Windows clipboard and the X
 * selection under `xvfb-run` belong to the machine. Two workers that copy at the same moment
 * read each other's text — a spec polling for "curl" happily accepts the command another spec
 * just copied. A lock directory under the OS temp folder serialises the copy-and-read across
 * worker processes; `mkdir` is atomic, so whoever creates it holds the clipboard.
 */
const LOCK_DIR = join(tmpdir(), 'wirebench-e2e-clipboard.lock');
/** A holder that crashed mid-test leaves the directory behind; past this age it is stale. */
const STALE_MS = 60_000;

async function acquire(): Promise<void> {
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    try {
      if (Date.now() - statSync(LOCK_DIR).mtimeMs > STALE_MS) {
        rmSync(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
    } catch {
      // Released between the mkdir and the stat: try again straight away.
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Runs `copy` (the click that puts text on the clipboard) while holding the clipboard, waits for
 * the clipboard to contain `expected` — something only this spec's copy can produce, such as its
 * own server's URL — and returns the clipboard text.
 */
export async function copyAndRead(
  app: ElectronApplication,
  copy: () => Promise<void>,
  expected: string,
): Promise<string> {
  await acquire();
  try {
    // Start from empty, so text left by an earlier copy can never satisfy the poll below.
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await copy();
    await expect
      .poll(async () => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toContain(expected);
    return await app.evaluate(({ clipboard }) => clipboard.readText());
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}
