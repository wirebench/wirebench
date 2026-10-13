import { beforeEach, describe, expect, it } from 'vitest';
import {
  broadcastOf,
  noteWriteMany,
  pruneBroadcast,
  receiversFor,
  setTicked,
  stopBroadcast,
  toggleBroadcast,
  useBroadcastStore,
} from '../../src/renderer/features/ssh/panes/broadcast.js';

const SESSIONS = { p1: 's1', p2: 's2', p3: undefined };

describe('receiversFor', () => {
  it('off: only the pane’s own session', () => {
    expect(receiversFor({ on: false, ticked: new Set(['p1', 'p2']) }, 'p1', SESSIONS)).toEqual(['s1']);
  });

  it('on and ticked: every ticked pane with a session', () => {
    expect(receiversFor({ on: true, ticked: new Set(['p1', 'p2', 'p3']) }, 'p2', SESSIONS)).toEqual(['s1', 's2']);
  });

  it('on and unticked: only its own', () => {
    expect(receiversFor({ on: true, ticked: new Set(['p2']) }, 'p1', SESSIONS)).toEqual(['s1']);
  });

  it('a pane without a session receives nothing, its own keystrokes included', () => {
    expect(receiversFor({ on: false, ticked: new Set() }, 'p3', SESSIONS)).toEqual([]);
  });
});

describe('the broadcast store', () => {
  beforeEach(() => {
    useBroadcastStore.setState({ tabs: {} });
  });

  it('turns on with every pane ticked, and off again', () => {
    toggleBroadcast('t', ['p1', 'p2', 'p3']);
    expect(broadcastOf('t')).toMatchObject({ on: true, ticked: new Set(['p1', 'p2', 'p3']), missed: 0 });
    toggleBroadcast('t', ['p1', 'p2', 'p3']);
    expect(broadcastOf('t').on).toBe(false);
  });

  it('needs two or more panes', () => {
    toggleBroadcast('t', ['p1']);
    expect(broadcastOf('t').on).toBe(false);
  });

  it('ticks and unticks one pane', () => {
    toggleBroadcast('t', ['p1', 'p2', 'p3']);
    setTicked('t', 'p2', false);
    expect([...broadcastOf('t').ticked]).toEqual(['p1', 'p3']);
    setTicked('t', 'p2', true);
    expect(broadcastOf('t').ticked.has('p2')).toBe(true);
  });

  it('a skipped write is remembered until the next write reaches every receiver', () => {
    toggleBroadcast('t', ['p1', 'p2']);
    noteWriteMany('t', 1);
    expect(broadcastOf('t').missed).toBe(1);
    noteWriteMany('t', 0);
    expect(broadcastOf('t').missed).toBe(0);
  });

  it('a closed pane leaves the ticks, and one pane left turns it off', () => {
    toggleBroadcast('t', ['p1', 'p2', 'p3']);
    pruneBroadcast('t', ['p1', 'p2']);
    expect(broadcastOf('t')).toMatchObject({ on: true, ticked: new Set(['p1', 'p2']) });
    pruneBroadcast('t', ['p1']);
    expect(broadcastOf('t').on).toBe(false);
  });

  it('stops for one tab only', () => {
    toggleBroadcast('t', ['p1', 'p2']);
    toggleBroadcast('u', ['q1', 'q2']);
    stopBroadcast('t');
    expect(broadcastOf('t').on).toBe(false);
    expect(broadcastOf('u').on).toBe(true);
  });
});
