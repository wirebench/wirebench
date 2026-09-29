import { afterEach, describe, expect, it } from 'vitest';
import { useCaptureFocusStore } from '../../src/renderer/state/capture-focus.js';

afterEach(() => useCaptureFocusStore.setState({ focus: undefined }));

describe('capture focus (callback-assertion §5)', () => {
  it('hands a focused capture to its own catch URL, once', () => {
    useCaptureFocusStore.getState().focusCapture('H1', 'C1');
    expect(useCaptureFocusStore.getState().take('H2')).toBeUndefined();
    expect(useCaptureFocusStore.getState().take('H1')).toBe('C1');
    expect(useCaptureFocusStore.getState().take('H1')).toBeUndefined();
  });
});
