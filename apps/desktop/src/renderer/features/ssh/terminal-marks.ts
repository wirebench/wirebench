import { create } from 'zustand';

/**
 * What a terminal did while nobody was looking at it (#422), worst last: it printed, it asks for input,
 * or it failed. A pane (or a local terminal tab) holds at most one; a worse one replaces a milder one.
 */
export type TerminalMark = 'unread' | 'input' | 'error';

const RANK: Readonly<Record<TerminalMark, number>> = { unread: 1, input: 2, error: 3 };

/** Where the terminal is as the user sees it. */
export interface MarkView {
  /** Its tab is in front, so its output is on screen. */
  readonly inFront: boolean;
  /** Keystrokes go to it. */
  readonly focused: boolean;
}

export type MarkEvent =
  /** It printed; `prompt` when what it printed ends in a prompt for input. */
  | { readonly kind: 'output'; readonly prompt: boolean }
  /** Its session ended badly: a non-zero exit, a dropped connection, a connect that failed. */
  | { readonly kind: 'error' }
  /** The user moved: its tab came to the front, or it got the keys. */
  | { readonly kind: 'view'; readonly view: MarkView };

function worse(a: TerminalMark | undefined, b: TerminalMark): TerminalMark {
  return a !== undefined && RANK[a] >= RANK[b] ? a : b;
}

/**
 * What is left of a mark once the user sees the terminal as `view`: the focused terminal of the tab in
 * front has nothing to tell; another pane of that tab is on screen, so its new output is seen, but a
 * prompt or an error there still waits for the user to go to it.
 */
function settle(mark: TerminalMark | undefined, view: MarkView): TerminalMark | undefined {
  if (!view.inFront) return mark;
  if (view.focused || mark === 'unread') return undefined;
  return mark;
}

/** The mark after `event`, with the terminal seen as `view`. */
export function nextMark(mark: TerminalMark | undefined, event: MarkEvent, view: MarkView): TerminalMark | undefined {
  switch (event.kind) {
    case 'view':
      return settle(mark, event.view);
    case 'output':
      return settle(event.prompt ? worse(mark, 'input') : worse(mark, 'unread'), view);
    case 'error':
      return settle(worse(mark, 'error'), view);
  }
}

/** The tab's mark: the worst of its panes'. */
export function worstMark(
  marks: Readonly<Record<string, TerminalMark>>,
  keys: Iterable<string>,
): TerminalMark | undefined {
  let found: TerminalMark | undefined;
  for (const key of keys) {
    const mark = marks[key];
    if (mark !== undefined) found = worse(found, mark);
  }
  return found;
}

// CSI and OSC sequences, and the two-byte escapes, which a prompt may be coloured or titled with.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
/** A prompt is short; a long last line is output that happens to end in a colon. */
const PROMPT_MAX = 160;
/** How much of the output is kept to find a prompt split across chunks. */
const TAIL_MAX = 512;

const PROMPTS: readonly RegExp[] = [
  // Password:  [sudo] password for bob:  bob@host's password:  Enter passphrase for key '/k':
  // Verification code:  Enter PIN for 'token':  One-time password (OTP):
  /\b(password|passphrase|passcode|pin|verification code|one-time code|otp)\b[^\n]*:\s*$/i,
  // Are you sure you want to continue connecting (yes/no/[fingerprint])?   Proceed? [y/N]   Overwrite (y/n)?
  /[([](yes\/no(\/\[fingerprint\])?|y\/n)[)\]]\s*[?:]?\s*$/i,
];

/** Whether the last line the output leaves on screen asks for a password, a passphrase, a code or a yes. */
export function endsInPrompt(text: string): boolean {
  const plain = text.replace(ESCAPES, '');
  const line = plain.slice(Math.max(plain.lastIndexOf('\n'), plain.lastIndexOf('\r')) + 1);
  if (line.trim() === '' || line.length > PROMPT_MAX) return false;
  return PROMPTS.some((pattern) => pattern.test(line));
}

/** Reads one session's output chunk by chunk and says after each whether it ends in a prompt. */
export function promptWatcher(): (bytes: Uint8Array) => boolean {
  const decoder = new TextDecoder();
  let tail = '';
  return (bytes) => {
    tail = (tail + decoder.decode(bytes, { stream: true })).slice(-TAIL_MAX);
    return endsInPrompt(tail);
  };
}

interface TerminalMarksState {
  /** By pane id for an SSH pane, by tab id for a local terminal tab. */
  readonly marks: Readonly<Record<string, TerminalMark>>;
  readonly views: Readonly<Record<string, MarkView>>;
}

export const useTerminalMarksStore = create<TerminalMarksState>(() => ({ marks: {}, views: {} }));

const HIDDEN: MarkView = { inFront: false, focused: false };

function apply(key: string, event: MarkEvent): void {
  useTerminalMarksStore.setState((state) => {
    const view = event.kind === 'view' ? event.view : (state.views[key] ?? HIDDEN);
    const mark = nextMark(state.marks[key], event, view);
    const views = event.kind === 'view' ? { ...state.views, [key]: event.view } : state.views;
    if (mark === state.marks[key]) return views === state.views ? state : { views };
    const marks = { ...state.marks };
    if (mark === undefined) delete marks[key];
    else marks[key] = mark;
    return { marks, views };
  });
}

/** The terminal printed; `prompt` when the output ends in a prompt for input. */
export function noteOutput(key: string, prompt: boolean): void {
  apply(key, { kind: 'output', prompt });
}

/** The terminal's session ended badly or never started. */
export function noteError(key: string): void {
  apply(key, { kind: 'error' });
}

/** Where the user sees the terminal now; coming to the front or getting the keys clears its mark. */
export function noteView(key: string, view: MarkView): void {
  const was = useTerminalMarksStore.getState().views[key];
  if (was?.inFront === view.inFront && was.focused === view.focused) return;
  apply(key, { kind: 'view', view });
}

/** The terminal is gone: its pane closed, or its tab. */
export function forgetMark(key: string): void {
  useTerminalMarksStore.setState((state) => {
    if (state.marks[key] === undefined && state.views[key] === undefined) return state;
    const marks = { ...state.marks };
    const views = { ...state.views };
    delete marks[key];
    delete views[key];
    return { marks, views };
  });
}

/** How each mark is spoken. */
export const MARK_LABEL: Readonly<Record<TerminalMark, string>> = {
  unread: 'New output',
  input: 'Waiting for input',
  error: 'Error or disconnected',
};
