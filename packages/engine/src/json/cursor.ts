/**
 * Where a cursor sits in a JSON document, worked out from the text alone.
 *
 * The counterpart of `xsd/locate.ts`'s `completionContextAt` for XML, and it exists for the same
 * reason: a completion provider runs against a document that is, by definition, half-typed, so a
 * parse is the one thing that cannot be relied on. This scans characters left to right, keeping a
 * stack of the containers it has entered, and answers what object the cursor is in, what key has
 * been typed so far, and which keys that object already holds.
 *
 * Array indices are not path segments. A repeated field's items all have the element type, so
 * `{"items": [{ | }]}` is at `["items"]` — the same place a singular message field would be. The
 * one container that does add a segment of its own is a map, whose keys the user names; a caller
 * resolving the path against a schema consumes that segment itself.
 *
 * Nothing here knows about protobuf: it is a JSON text helper, and the schema half lives in
 * `grpc/proto/describe.ts`.
 */

/** A half-open character range in a text document. */
export interface JsonTextRange {
  readonly start: number;
  readonly end: number;
}

/** What a completion provider needs to offer the keys of the object the cursor is in. */
export interface JsonCompletionContext {
  /** Object keys from the document root down to the containing object, outermost first. */
  readonly path: readonly string[];
  /** The key text typed so far, without its quotes. */
  readonly partial: string;
  /** The range of `partial` in the document, to replace with the accepted key. */
  readonly replaceRange: JsonTextRange;
  /** Whether `replaceRange` lies inside a quoted string, so an accepted key brings no quotes of its own. */
  readonly quoted: boolean;
  /** The keys this object already holds, which JSON will not let it repeat. */
  readonly siblings: readonly string[];
}

interface Frame {
  readonly kind: 'object' | 'array';
  /** The key this container sits under in its parent object, when it has one. */
  readonly segment?: string;
  /** Keys read in this object so far. */
  readonly keys: string[];
  /** The key most recently read, whose value the scanner is now in. */
  pendingKey?: string;
  /** Whether the scanner has passed the `:` after `pendingKey`. */
  afterColon: boolean;
}

/** Where a string starting at `start` ends, and whether a quote or a line break ended it. */
function endOfString(text: string, start: number): { readonly end: number; readonly closed: boolean } {
  let i = start;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '"') {
      return { end: i, closed: true };
    }
    // An unterminated string is taken to end at the line break. A user who has not closed one has
    // moved on, and stopping here keeps a single missing quote from swallowing the rest of the file.
    if (char === '\n') {
      return { end: i, closed: false };
    }
    i += 1;
  }
  return { end: text.length, closed: false };
}

/** Whether a container is entered at the value position of an object, and so takes its key as a segment. */
function segmentFor(parent: Frame | undefined): string | undefined {
  if (parent === undefined || parent.kind !== 'object' || !parent.afterColon) {
    return undefined;
  }
  return parent.pendingKey;
}

function enter(stack: Frame[], kind: 'object' | 'array'): void {
  const segment = segmentFor(stack[stack.length - 1]);
  stack.push({ kind, keys: [], afterColon: false, ...(segment !== undefined ? { segment } : {}) });
}

/** The path a stack of frames spells: every segment it carries, arrays included, root excluded. */
function pathOf(stack: readonly Frame[]): string[] {
  const path: string[] = [];
  for (const frame of stack) {
    if (frame.segment !== undefined) {
      path.push(frame.segment);
    }
  }
  return path;
}

/** Where a cursor inside a quoted string lands, once the scanner has reached it. */
interface CursorString {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly isKey: boolean;
}

/** The characters a bare (unquoted) key token is made of. */
const WORD = /[A-Za-z0-9_]/;

/**
 * Pure text analysis for a JSON completion provider: the object the cursor is in, the key being
 * typed and the range to replace with the accepted one.
 *
 * Returns `undefined` wherever a key cannot go — in a value, directly inside an array, at the top
 * level outside any object, or anywhere a key would not be the next thing written.
 */
export function jsonCompletionContextAt(text: string, offset: number): JsonCompletionContext | undefined {
  const stack: Frame[] = [];
  let cursorString: CursorString | undefined;
  let i = 0;

  while (i < offset) {
    const char = text[i] as string;
    const top = stack[stack.length - 1];
    if (char === '"') {
      const contentStart = i + 1;
      const { end: contentEnd, closed } = endOfString(text, contentStart);
      const isKey = top !== undefined && top.kind === 'object' && !top.afterColon;
      // The position just past a key's closing quote still belongs to that key: the user has typed
      // it and not yet reached for the colon, so completing it is what they are asking for.
      const last = isKey && closed ? contentEnd + 1 : contentEnd;
      if (offset >= contentStart && offset <= last) {
        cursorString = { contentStart, contentEnd, isKey };
        break;
      }
      if (isKey && top !== undefined) {
        const key = text.slice(contentStart, contentEnd);
        top.pendingKey = key;
        top.keys.push(key);
      }
      if (!closed && top !== undefined && top.kind === 'object') {
        // The value was abandoned at the line break, so the next line starts a member of its own.
        top.afterColon = false;
        delete top.pendingKey;
      }
      i = contentEnd + 1;
      continue;
    }
    if (char === '{' || char === '[') {
      enter(stack, char === '{' ? 'object' : 'array');
    } else if (char === '}' || char === ']') {
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent !== undefined && parent.kind === 'object') {
        parent.afterColon = false;
        delete parent.pendingKey;
      }
    } else if (char === ':') {
      if (top !== undefined && top.kind === 'object') {
        top.afterColon = true;
      }
    } else if (char === ',') {
      if (top !== undefined && top.kind === 'object') {
        top.afterColon = false;
        delete top.pendingKey;
      }
    }
    i += 1;
  }

  const frame = stack[stack.length - 1];
  if (frame === undefined || frame.kind !== 'object') {
    return undefined;
  }

  if (cursorString !== undefined) {
    if (!cursorString.isKey) {
      return undefined;
    }
    return {
      path: pathOf(stack),
      partial: text.slice(cursorString.contentStart, Math.min(offset, cursorString.contentEnd)),
      replaceRange: { start: cursorString.contentStart, end: cursorString.contentEnd },
      quoted: true,
      siblings: [...frame.keys],
    };
  }

  if (frame.afterColon) {
    return undefined;
  }
  // An unquoted word is still worth completing: Monaco asks as soon as a letter is typed, and a
  // user who has not reached for the quote key yet means the same thing by it.
  let start = offset;
  while (start > 0 && WORD.test(text[start - 1] as string)) {
    start -= 1;
  }
  let before = start - 1;
  while (before >= 0 && /\s/.test(text[before] as string)) {
    before -= 1;
  }
  const preceding = before >= 0 ? (text[before] as string) : '';
  if (preceding !== '{' && preceding !== ',') {
    return undefined;
  }
  let end = offset;
  while (end < text.length && WORD.test(text[end] as string)) {
    end += 1;
  }
  return {
    path: pathOf(stack),
    partial: text.slice(start, offset),
    replaceRange: { start, end },
    quoted: false,
    siblings: [...frame.keys],
  };
}
