import { useEffect, useState } from 'react';

/** The part of the Local Font Access API used here; TypeScript's DOM library does not declare it yet. */
type QueryLocalFonts = () => Promise<readonly { readonly family: string }[]>;

/**
 * Whether a family draws every character the same width: a row of `i` measures as wide as a row of `M`.
 * The fallback behind it is proportional, so a family the canvas cannot find does not pass.
 */
function canvasMonospaceCheck(): ((family: string) => boolean) | undefined {
  const context = document.createElement('canvas').getContext('2d');
  if (context === null) return undefined;
  return (family) => {
    context.font = `16px "${family.replaceAll('"', '')}", serif`;
    return context.measureText('iiiiiiiiii').width === context.measureText('MMMMMMMMMM').width;
  };
}

/** The distinct families among `fonts` that pass `isMonospace`, sorted. */
export function monospaceFamilies(
  fonts: readonly { readonly family: string }[],
  isMonospace: (family: string) => boolean,
): string[] {
  const families = [...new Set(fonts.map((font) => font.family))].filter((family) => family.trim() !== '');
  return families.filter(isMonospace).sort((a, b) => a.localeCompare(b));
}

/**
 * The machine's monospaced font families, listed once per mount; `undefined` while listing, `null` when the
 * platform cannot list them (no API, permission refused, no canvas to measure with), so the caller offers a
 * text field instead.
 */
export function useInstalledMonospaceFonts(): readonly string[] | null | undefined {
  const [fonts, setFonts] = useState<readonly string[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const query = (window as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
    const isMonospace = query === undefined ? undefined : canvasMonospaceCheck();
    if (query === undefined || isMonospace === undefined) {
      setFonts(null);
      return;
    }
    query()
      .then((all) => {
        if (live) setFonts(monospaceFamilies(all, isMonospace));
      })
      .catch(() => {
        if (live) setFonts(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}
