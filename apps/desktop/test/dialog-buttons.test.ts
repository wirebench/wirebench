import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SSH = join(import.meta.dirname, '../src/renderer/features/ssh');

/** Dialogs whose actions drew their own buttons, each with its own padding and focus ring (#537 F37). */
const DIALOGS = ['trust-dialog.tsx', 'paste-dialog.tsx', 'files/conflict-dialog.tsx'];

describe('SSH dialogs use the shared Button (#537)', () => {
  it.each(DIALOGS)('%s draws no <button> of its own', (file) => {
    const source = readFileSync(join(SSH, file), 'utf-8');
    expect(source).toMatch(/import \{ Button \} from '[./]+\/components\/button\.js';/);
    expect(source).not.toContain('<button');
  });

  it("the session log viewer's Close is the shared Button", () => {
    const source = readFileSync(join(SSH, 'session-logs.tsx'), 'utf-8');
    const viewer = source.slice(source.indexOf('function LogViewerBody('));
    expect(viewer).toContain('<Dialog.Close asChild>\n          <Button>Close</Button>');
  });
});
