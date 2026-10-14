import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER = join(import.meta.dirname, '../src/renderer');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

const css = (name: string): string => readFileSync(join(RENDERER, 'styles', name), 'utf-8');

describe('the layer scale (#536)', () => {
  it('sets menus at 40, dialogs at 50 and toasts at 60, once', () => {
    const tokens = css('tokens.css');
    expect(tokens).toContain('--wb-layer-dropdown: 40;');
    expect(tokens).toContain('--wb-layer-dialog: 50;');
    expect(tokens).toContain('--wb-layer-toast: 60;');
    const tailwind = css('tailwind.css');
    for (const layer of ['dropdown', 'dialog', 'toast']) {
      expect(tailwind).toContain(`@utility z-${layer} {\n  z-index: var(--wb-layer-${layer});`);
    }
  });

  it('puts every Dialog and AlertDialog portalled to <body> on the dialog layer', () => {
    expect(css('tailwind.css')).toMatch(
      /body > \[data-state\]:not\(\[data-radix-popper-content-wrapper\]\) \{\n\s+z-index: var\(--wb-layer-dialog\);/,
    );
  });

  it('leaves no dialog overlay or content with a z-index of its own, which would step out of the scale', () => {
    const offenders: string[] = [];
    for (const file of sources(RENDERER)) {
      const text = readFileSync(file, 'utf-8');
      for (const match of text.matchAll(/<(?:Alert)?Dialog\.(?:Overlay|Content)\b[^>]*>/g)) {
        if (/\bz-/.test(match[0])) offenders.push(`${relative(RENDERER, file)}: ${match[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('draws toasts on the toast layer, above any dialog', () => {
    expect(readFileSync(join(RENDERER, 'components/toast.tsx'), 'utf-8')).toContain('z-toast');
  });

  it('keeps the split divider inside the pane area, which is its own stacking context', () => {
    const divider = readFileSync(join(RENDERER, 'features/ssh/panes/split-divider.tsx'), 'utf-8');
    expect(divider).toContain('absolute z-[1] ');
    const view = readFileSync(join(RENDERER, 'features/ssh/panes/pane-view.tsx'), 'utf-8');
    expect(view).toMatch(/className="relative isolate /);
  });
});
