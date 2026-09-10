import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Replaces the full contents of a Monaco editor identified by its `aria-label` (`testId`) with
 * `text`, then waits until the rendered text actually shows it landed.
 *
 * Character-by-character `page.keyboard.type()` into Monaco is flaky here: Monaco's own
 * autoclosing-bracket/quote behaviour and IME/composition handling can eat or duplicate
 * keystrokes typed one at a time, especially for XML-heavy strings full of `<`/`>`/`"`. This
 * clicks in, selects everything, and delivers the whole string as a single `insertText` input
 * event instead — the same technique `editor.spec.ts`'s re-indent test already used ad hoc —
 * then polls (rather than asserting once) until a sentinel from the end of `text` shows up in
 * the editor's own rendered `.view-line` spans, which is what actually reflects committed
 * content rather than the framing container's text.
 */
/**
 * The visible Monaco widget carrying `label`.
 *
 * The `aria-label` itself lands on Monaco's edit-context host — a zero-size div that Playwright
 * correctly reports as hidden — so every "the editor is on screen" assertion has to be made
 * against the widget wrapped around it instead.
 */
export function monacoEditor(page: Page, label: string): Locator {
  return page.locator(`[aria-label="${label}"]`).locator('xpath=ancestor::*[contains(@class, "monaco-editor")][1]');
}

export async function setMonacoText(page: Page, testId: string, text: string): Promise<void> {
  // `aria-label` lands on Monaco's own hidden input element, a sibling of the `.view-line` spans
  // it renders — not their ancestor — so the two are queried separately below.
  const editor = page.locator(`[aria-label="${testId}"]`);
  await editor.waitFor({ state: 'attached', timeout: 20_000 });
  // The labelled element is Monaco's own edit-context host: a zero-size div, which Playwright
  // rightly calls hidden. What has to be on screen (and is what a user clicks) is the editor
  // widget around it, so wait on — and click — that instead.
  const root = editor.locator('xpath=ancestor::*[contains(@class, "monaco-editor")][1]');
  await expect(root).toBeVisible({ timeout: 20_000 });
  // Click the visible widget (the host div has no box of its own to click), then focus the
  // host so the keystrokes below reach Monaco's edit context.
  await root.click({ position: { x: 8, y: 8 } });
  await editor.focus();

  const isMac = process.platform === 'darwin';
  const mod = isMac ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(text);

  // A short, distinctive tail of the typed text — long enough to be unlikely to already appear
  // in the document, short enough to survive being split across `.view-line` elements is not a
  // concern since it comes from a single (possibly multi-line) insertion; take the last
  // non-empty line so a trailing newline in `text` doesn't produce an empty sentinel.
  const lines = text.split('\n').filter((line) => line.length > 0);
  const sentinel = (lines[lines.length - 1] ?? text).trim();

  // `.view-line` isn't a descendant of the aria-labelled input, so scope the read to the
  // nearest `.monaco-editor` root that wraps both it and the rendered lines — not `page` at
  // large, which would also see any other Monaco instance on screen (e.g. the response pane).
  const monacoRoot = root;
  await expect
    .poll(
      async () => {
        const lineTexts = await monacoRoot.locator('.view-line').allTextContents();
        return lineTexts.join('\n');
      },
      { timeout: 10_000 },
    )
    .toContain(sentinel);
}
