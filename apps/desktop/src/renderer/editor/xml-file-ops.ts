/**
 * Save as… / Load from… for the request editor's raw XML text, over the `fs.*` IPC channels.
 * Kept side-effecting and IPC-shaped separately from `xml-language.ts`'s pure helpers so those
 * stay trivially unit-testable.
 */

/** Writes `text` to a file the user picks (or the e2e override), returning the chosen path, if any. */
export async function saveXmlAs(text: string, defaultName = 'request.xml'): Promise<string | undefined> {
  const result = await window.wirebench.fs.saveText({ text, defaultName });
  return result.ok ? result.value.path : undefined;
}

/**
 * Loads XML text from a file the user picks. When `currentText` is non-empty, requires
 * `confirm` to return `true` before replacing it — no diff preview, per the product decision
 * for this task. `confirm` defaults to the browser's native `confirm()`.
 */
export async function loadXmlFrom(
  currentText: string,
  confirm: (message: string) => boolean = (message) => window.confirm(message),
): Promise<string | undefined> {
  if (currentText.trim() !== '') {
    const proceed = confirm('Loading a file will replace the current request envelope. Continue?');
    if (!proceed) {
      return undefined;
    }
  }
  const result = await window.wirebench.fs.openText({});
  return result.ok ? result.value.text : undefined;
}
