/**
 * The WebSocket timeline and the frame detail under it.
 *
 * What a user would notice going wrong: a row that does not say which way it went, a binary frame
 * shown as garbage instead of hex, a control frame that cannot be hidden, a filter that misses, a
 * long session that paints every row it ever saw, and a selected frame whose detail does not show
 * the payload (or pretends to have one it did not keep).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { WS_TIMELINE_WINDOW, WsTimeline } from '../../src/renderer/features/ws-editor/timeline.js';
import { WsFrameDetail } from '../../src/renderer/features/ws-editor/frame-detail.js';
import {
  closeCodeMeaning,
  formatElapsed,
  formatFrameTime,
  framePreview,
  hexDump,
  isSendableCloseCode,
  parseBinaryInput,
  subprotocolProblem,
  utf8Length,
} from '../../src/renderer/features/ws-editor/ws-format.js';
import { WS_LIVE_FRAME_LIMIT, useExchangesStore } from '../../src/renderer/state/exchanges.js';
import type { WsFrameWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

function frame(overrides: Partial<WsFrameWire> = {}): WsFrameWire {
  return { index: 0, direction: 'received', opcode: 'text', at: 1234, size: 2, text: 'hi', ...overrides };
}

const FRAMES: readonly WsFrameWire[] = [
  frame({ index: 0, direction: 'sent', text: '{"hello":"world"}', size: 17, at: 5 }),
  frame({ index: 1, direction: 'received', text: 'welcome aboard', size: 14, at: 61_042 }),
  frame({
    index: 2,
    direction: 'received',
    opcode: 'binary',
    text: undefined,
    base64: btoa('\x00\x01\x02\xff'),
    size: 4,
  }),
  frame({ index: 3, direction: 'received', opcode: 'ping', text: undefined, size: 0 }),
  frame({ index: 4, direction: 'sent', opcode: 'pong', text: undefined, size: 0 }),
];

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('ws-frame-row');
}

afterEach(() => {
  cleanup();
});

describe('ws-format', () => {
  it('formats times, previews, close meanings and byte lengths', () => {
    expect(formatFrameTime(61_042)).toBe('01:01.042');
    expect(formatElapsed(42_900)).toBe('00:42');
    expect(framePreview(frame({ opcode: 'binary', text: undefined, base64: btoa('\x0a\xff') }))).toBe('0a ff');
    expect(framePreview(frame({ opcode: 'close', text: undefined, close: { code: 1000, reason: 'bye' } }))).toBe(
      '1000 bye',
    );
    expect(framePreview(frame({ payloadTruncated: true }))).toBe('(payload not kept)');
    expect(closeCodeMeaning(1006)).toBe('Abnormal closure');
    expect(closeCodeMeaning(4001)).toBe('Private use');
    expect(isSendableCloseCode(1000)).toBe(true);
    expect(isSendableCloseCode(1001)).toBe(false);
    expect(isSendableCloseCode(4999)).toBe(true);
    expect(utf8Length('é')).toBe(2);
    expect(hexDump(btoa('AB'))).toBe('00000000  41 42' + ' '.repeat(42) + '  AB');
  });

  it('reads binary input as hex or base64 and says why it cannot', () => {
    expect(parseBinaryInput('0a ff')).toEqual({ ok: true, base64: btoa('\x0a\xff') });
    expect(parseBinaryInput('AQID')).toEqual({ ok: true, base64: 'AQID' });
    expect(parseBinaryInput('abc')).toEqual({ ok: false, reason: 'Hex needs two digits per byte.' });
    expect(parseBinaryInput('not *base64')).toEqual({ ok: false, reason: 'Not hex or base64.' });
  });

  it('refuses subprotocol tokens with a space, a comma or non-ASCII', () => {
    expect(subprotocolProblem('chat.v2')).toBeUndefined();
    expect(subprotocolProblem('chat v2')).toMatch(/space/);
    expect(subprotocolProblem('a,b')).toMatch(/comma/);
    expect(subprotocolProblem('çhat')).toMatch(/ASCII/);
  });
});

describe('WsTimeline', () => {
  it('renders a row per frame with its arrow, time, opcode chip, size and preview', () => {
    render(<WsTimeline frames={FRAMES} />);

    expect(rows()).toHaveLength(5);
    const [sent, received, binary] = rows();
    expect(within(sent!).getByLabelText('Sent')).toBeTruthy();
    expect(within(received!).getByLabelText('Received')).toBeTruthy();
    expect(received!.textContent).toContain('01:01.042');
    expect(received!.textContent).toContain('welcome aboard');
    // A text row has no opcode chip; a binary one does, and previews its first bytes as hex.
    expect(within(sent!).queryByTestId('ws-frame-opcode')).toBeNull();
    expect(within(binary!).getByTestId('ws-frame-opcode').textContent).toBe('binary');
    expect(binary!.textContent).toContain('00 01 02 ff');
    expect(binary!.textContent).toContain('4 B');
  });

  it('keys rows by frame index, so a new frame keeps the rows already painted', () => {
    const { rerender } = render(<WsTimeline frames={FRAMES.slice(0, 2)} />);
    const first = rows()[0];
    rerender(<WsTimeline frames={FRAMES.slice(0, 3)} />);
    expect(rows()[0]).toBe(first);
    expect(rows()).toHaveLength(3);
  });

  it('hides control frames with one toggle and filters by direction and text', () => {
    render(<WsTimeline frames={FRAMES} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Control frames' }));
    expect(rows()).toHaveLength(3);

    fireEvent.click(screen.getByRole('radio', { name: 'Sent' }));
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Received' }));
    expect(rows()).toHaveLength(2);
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter frames' }), { target: { value: 'WELCOME' } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain('welcome aboard');
  });

  it('selects a row by click and by arrow keys', () => {
    const onSelect = vi.fn();
    render(<WsTimeline frames={FRAMES} selectedIndex={1} onSelect={onSelect} />);

    expect(rows()[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(rows()[2]!);
    expect(onSelect).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Frames' }), { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Frames' }), { key: 'ArrowUp' });
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it('follows the newest row only while scrolled to the bottom', () => {
    const { rerender } = render(<WsTimeline frames={FRAMES.slice(0, 2)} />);
    const scroller = screen.getByTestId('ws-timeline-scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });

    rerender(<WsTimeline frames={FRAMES.slice(0, 3)} />);
    expect(scroller.scrollTop).toBe(1000);

    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    rerender(<WsTimeline frames={FRAMES.slice(0, 4)} />);
    expect(scroller.scrollTop).toBe(200);
  });

  it('renders a window, not every row, past a thousand frames', () => {
    const many = Array.from({ length: 5000 }, (_, index) => frame({ index, text: `message ${String(index)}` }));
    render(<WsTimeline frames={many} />);

    expect(rows().length).toBeLessThan(WS_TIMELINE_WINDOW);
    expect(rows().length).toBeGreaterThan(0);
    // Pinned to the bottom, so the newest frame is the one on screen.
    expect(rows().at(-1)!.textContent).toContain('message 4999');
    expect(screen.getByTestId('ws-timeline-count').textContent).toContain('5000');
  });

  it('shows how many earlier frames were dropped from memory', () => {
    render(<WsTimeline frames={FRAMES} droppedFrames={12} />);
    expect(screen.getByTestId('ws-timeline-dropped').textContent).toContain('12 earlier frames');
  });

  it('counts the whole session, not just the frames still held, once past the cap', () => {
    const held = Array.from({ length: 5000 }, (_, index) => frame({ index: index + 25 }));
    render(<WsTimeline frames={held} droppedFrames={25} />);

    // 5025 happened; 5000 are still in memory. The status line's running counts never forgot the
    // 25 that were let go, so neither may this total.
    expect(screen.getByTestId('ws-timeline-count').textContent).toContain('5025');
  });
});

describe('WsFrameDetail', () => {
  it('pretty-prints a text frame and shows it raw on request', () => {
    render(<WsFrameDetail frame={FRAMES[0]!} />);
    const viewer = screen.getByLabelText<HTMLTextAreaElement>('Frame payload');
    expect(viewer.value).toBe('{\n  "hello": "world"\n}');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Raw' }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Frame payload').value).toBe('{"hello":"world"}');
  });

  it('shows a binary frame as a hex dump and copies it as base64', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<WsFrameDetail frame={FRAMES[2]!} />);
    expect(screen.getByTestId('ws-frame-hex').textContent).toContain('00 01 02 ff');
    fireEvent.click(screen.getByRole('button', { name: 'Copy as base64' }));
    expect(writeText).toHaveBeenCalledWith(btoa('\x00\x01\x02\xff'));
  });

  it('shows a close frame’s code, its meaning and the reason', () => {
    render(
      <WsFrameDetail frame={frame({ opcode: 'close', text: undefined, close: { code: 1008, reason: 'no thanks' } })} />,
    );
    const detail = screen.getByTestId('ws-frame-close');
    expect(detail.textContent).toContain('1008');
    expect(detail.textContent).toContain('Policy violation');
    expect(detail.textContent).toContain('no thanks');
  });

  it('says when a payload was not kept', () => {
    render(<WsFrameDetail frame={frame({ text: undefined, payloadTruncated: true, size: 4_000_000 })} />);
    expect(screen.getByTestId('ws-frame-detail').textContent).toContain('payload was not kept');
  });
});

describe('the live frame cap', () => {
  beforeEach(() => {
    useExchangesStore.setState({
      wsByRequest: { 'ws-1': { status: 'open', sendId: 's1', live: { frames: [], open: true } } },
    });
  });

  it('keeps at most the limit in memory, dropping the oldest and counting them', () => {
    const apply = useExchangesStore.getState().applyWsLive;
    for (let index = 0; index < WS_LIVE_FRAME_LIMIT + 25; index += 1) {
      apply({ kind: 'frame', sendId: 's1', frame: frame({ index }) });
    }
    const live = useExchangesStore.getState().wsByRequest['ws-1']!.live!;
    expect(live.frames).toHaveLength(WS_LIVE_FRAME_LIMIT);
    expect(live.frames[0]!.index).toBe(25);
    expect(live.droppedFrames).toBe(25);
    // 5025 store updates over an array that grows to the cap: slower than the 5s default on CI.
  }, 30_000);

  it('keeps counting messages past the cap, and leaves control frames out', () => {
    const apply = useExchangesStore.getState().applyWsLive;
    for (let index = 0; index < WS_LIVE_FRAME_LIMIT + 25; index += 1) {
      apply({ kind: 'frame', sendId: 's1', frame: frame({ index, size: 2 }) });
    }
    apply({ kind: 'frame', sendId: 's1', frame: frame({ index: 99_999, opcode: 'ping', text: undefined, size: 4 }) });
    const counts = useExchangesStore.getState().wsByRequest['ws-1']!.live!.counts;
    expect(counts).toEqual({ sent: 0, received: WS_LIVE_FRAME_LIMIT + 25, bytes: (WS_LIVE_FRAME_LIMIT + 25) * 2 });
  }, 30_000);
});

describe('contract markers', () => {
  const violation = frame({
    index: 0,
    text: '{"text":1}',
    contract: {
      status: 'violation',
      message: 'chatMessage',
      problems: [{ path: '/text', keyword: 'type', message: 'expected string' }],
    },
  });
  const ok = frame({ index: 1, text: '{"text":"hi"}', contract: { status: 'ok', message: 'chatMessage' } });
  const unmatched = frame({
    index: 2,
    contract: { status: 'unmatched', reason: 'the contract declares no incoming messages on this channel' },
  });
  const notChecked = frame({ index: 3, contract: { status: 'not-checked' } });
  const plain = frame({ index: 4 });

  it('marks a violation with its first problem, and leaves an ok frame as it always looked', () => {
    render(<WsTimeline frames={[violation, ok]} />);
    const rows = screen.getAllByTestId('ws-frame-row');
    const marker = within(rows[0]!).getByTestId('ws-frame-contract-marker');
    expect(marker.getAttribute('aria-label')).toContain('/text — type: expected string');
    expect(within(rows[1]!).queryByTestId('ws-frame-contract-marker')).toBeNull();
  });

  it('marks an unmatched frame with its reason, and a not-checked one distinctly', () => {
    render(<WsTimeline frames={[unmatched, notChecked]} />);
    const [first, second] = screen.getAllByTestId('ws-frame-contract-marker');
    expect(first!.getAttribute('aria-label')).toContain('no incoming messages');
    expect(first!.getAttribute('data-status')).toBe('unmatched');
    expect(second!.getAttribute('aria-label')).toBe('Not checked — check took too long');
    expect(second!.getAttribute('data-status')).toBe('not-checked');
  });

  it('filters to the marked rows only when asked', () => {
    render(<WsTimeline frames={[violation, ok, unmatched, notChecked, plain]} />);
    expect(screen.getAllByTestId('ws-frame-row')).toHaveLength(5);
    fireEvent.click(screen.getByTestId('ws-timeline-contract-only'));
    expect(screen.getAllByTestId('ws-frame-row')).toHaveLength(2);
    expect(screen.getByTestId('ws-timeline-count').textContent).toBe('2 of 5 frames');
  });

  it('offers the toggle only when a frame was checked against a contract', () => {
    render(<WsTimeline frames={[plain]} />);
    expect(screen.queryByTestId('ws-timeline-contract-only')).toBeNull();
  });
});

describe('the frame detail’s Contract section', () => {
  it('names the matched message and lists each problem with its path', () => {
    render(
      <WsFrameDetail
        frame={frame({
          text: '{"text":1}',
          contract: {
            status: 'violation',
            message: 'chatMessage',
            problems: [
              { path: '/text', keyword: 'type', message: 'expected string' },
              { path: '/user', keyword: 'required', message: 'is required' },
            ],
          },
        })}
      />,
    );
    const section = screen.getByTestId('ws-frame-contract');
    expect(section.textContent).toContain('chatMessage');
    const items = within(section)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toEqual(['/text — type: expected string', '/user — required: is required']);
  });

  it('says a frame passed, and says nothing for a frame no contract checked', () => {
    const { unmount } = render(<WsFrameDetail frame={frame({ contract: { status: 'ok', message: 'chatMessage' } })} />);
    expect(screen.getByTestId('ws-frame-contract').textContent).toContain('Matches chatMessage');
    unmount();
    render(<WsFrameDetail frame={frame()} />);
    expect(screen.queryByTestId('ws-frame-contract')).toBeNull();
  });
});
