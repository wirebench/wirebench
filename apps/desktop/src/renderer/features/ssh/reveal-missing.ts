import { useState } from 'react';
import type { FocusEvent } from 'react';

/**
 * When a form says what it still needs: not while it is blank and new, but once Save is pressed or a
 * required field (`aria-required`) is left empty (#594). Give `onBlur` to the form; call `reveal` from a
 * submit that cannot save yet.
 */
export function useRevealMissing(): {
  readonly revealed: boolean;
  readonly reveal: () => void;
  readonly onBlur: (e: FocusEvent<HTMLFormElement>) => void;
} {
  const [revealed, setRevealed] = useState(false);
  return {
    revealed,
    reveal: () => {
      setRevealed(true);
    },
    onBlur: (e) => {
      const field = e.target;
      if (field instanceof HTMLInputElement && field.getAttribute('aria-required') === 'true' && field.value === '') {
        setRevealed(true);
      }
    },
  };
}
