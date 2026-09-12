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

/**
 * The full text of every Monaco model on the page, joined. Monaco virtualises its view lines,
 * so `toContainText` on the editor host only ever sees the lines currently scrolled into view;
 * assertions on content deeper in a document must read the model instead. Needs the e2e
 * Monaco handle (`globalThis.__wirebenchMonaco`, exposed when `WIREBENCH_E2E=1`).
 */
export async function monacoModelText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const monaco = (
      globalThis as unknown as {
        __wirebenchMonaco?: { editor: { getModels(): { getValue(): string }[] } };
      }
    ).__wirebenchMonaco;
    return monaco === undefined
      ? ''
      : monaco.editor
          .getModels()
          .map((m) => m.getValue())
          .join('\n');
  });
}

/** The go-to-definition modifier for this platform, matching the request editor's Mod+click. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * The sliver of the DOM {@link tokenCentre} walks inside the browser. The e2e project compiles
 * without the DOM lib (it is Node code that drives a browser), so the few members the measuring
 * callback touches are described here rather than imported.
 */
interface MeasurableNode {
  readonly nodeType: number;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<MeasurableNode>;
  readonly ownerDocument: {
    createRange(): {
      setStart(node: MeasurableNode, offset: number): void;
      setEnd(node: MeasurableNode, offset: number): void;
      getBoundingClientRect(): { left: number; top: number; width: number; height: number };
    };
  } | null;
}

/** A point in page coordinates. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The centre of the first run of `token`'s characters inside one rendered line, in page
 * coordinates, measured with a range over those very characters — `null` when the line no longer
 * carries them, which a line Monaco has just re-rendered briefly does not.
 */
async function tokenCentre(line: Locator, token: string): Promise<Point | null> {
  return await line
    .evaluate((element: MeasurableNode, needle: string): Point | null => {
      const TEXT_NODE = 3;
      const find = (node: MeasurableNode): Point | null => {
        if (node.nodeType === TEXT_NODE) {
          const index = (node.textContent ?? '').indexOf(needle);
          const range = node.ownerDocument?.createRange();
          if (index === -1 || range === undefined || range === null) {
            return null;
          }
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        for (let index = 0; index < node.childNodes.length; index += 1) {
          const child = node.childNodes[index];
          const hit = child === undefined ? null : find(child);
          if (hit !== null) {
            return hit;
          }
        }
        return null;
      };
      return find(element);
    }, token)
    .catch(() => null);
}

/**
 * Mod+clicks the characters `token` inside the Monaco editor labelled `label` — the second half
 * of go-to-definition.
 *
 * Clicking the `.view-line` locator itself is not the same gesture. Monaco lays every line out at
 * the width of the document's longest line and clips it to the editor's viewport, so Playwright
 * aims at the centre of the *visible* slice: the horizontal middle of the editor, a column that
 * has nothing to do with where `token` sits and that moves with the editor's width and with the
 * platform's character width. This measures the token's own characters instead and clicks their
 * centre, so the same characters are hit whatever the layout.
 */
export async function modClickToken(page: Page, label: string, token: string): Promise<void> {
  const editor = monacoEditor(page, label);
  const line = editor.locator('.view-line').filter({ hasText: token }).first();
  await expect(line).toBeVisible({ timeout: 20_000 });

  let target: Point | null = null;
  await expect
    .poll(
      async () => {
        target = await tokenCentre(line, token);
        return target;
      },
      { timeout: 20_000 },
    )
    .not.toBeNull();
  const point = target as Point | null;
  if (point === null) {
    throw new Error(`No "${token}" characters are rendered in the "${label}" editor`);
  }

  // A token scrolled out of the editor's own viewport would be clicked through whatever covers
  // it, which is exactly the silent mis-aim this helper exists to rule out.
  const box = await editor.boundingBox();
  if (box === null || point.x < box.x || point.x > box.x + box.width) {
    throw new Error(`"${token}" is outside the visible area of the "${label}" editor`);
  }

  await page.keyboard.down(MOD);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up(MOD);
}
