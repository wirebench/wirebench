/** The custom name's states (hosted edition spec §23.2): every move of the table, timed ones at their edges. */
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_STATES,
  FAILING_FOR_MS,
  isHeld,
  next,
  PENDING_FOR_MS,
  type DomainState,
} from '../../../src/custom-domains/states.js';

const CREATED = new Date('2026-11-01T00:00:00Z');
const at = (ms: number) => new Date(CREATED.getTime() + ms);
const since = { createdAt: CREATED, failingSince: null };
const PASS = { featured: true, passed: true };
const FAIL = { featured: true, passed: false };
const GONE = { featured: false, passed: true };

describe('next', () => {
  it('lists the seven states of §23.2', () => {
    expect([...DOMAIN_STATES]).toEqual(['pending', 'verified', 'active', 'failing', 'lapsed', 'paused', 'expired']);
    expect(DOMAIN_STATES.filter(isHeld)).toEqual(['verified', 'active', 'failing']);
  });

  it('moves a pending claim to verified on a pass', () => {
    expect(next('pending', PASS, at(60_000), since)).toBe('verified');
  });

  it('keeps a pending claim for 7 days, then expires it', () => {
    expect(next('pending', FAIL, at(PENDING_FOR_MS - 1), since)).toBe('pending');
    expect(next('pending', FAIL, at(PENDING_FOR_MS), since)).toBe('expired');
    expect(PENDING_FOR_MS).toBe(7 * 24 * 3_600_000);
  });

  it('keeps verified and active on a pass: only the certificate probe makes a name active', () => {
    expect(next('verified', PASS, at(0), since)).toBe('verified');
    expect(next('active', PASS, at(0), since)).toBe('active');
  });

  it('moves verified and active to failing on a failure', () => {
    expect(next('verified', FAIL, at(0), since)).toBe('failing');
    expect(next('active', FAIL, at(0), since)).toBe('failing');
  });

  it('keeps failing for 72 hours from failing_since, then lapses', () => {
    const failing = { createdAt: CREATED, failingSince: at(1_000) };
    expect(next('failing', FAIL, at(1_000 + FAILING_FOR_MS - 1), failing)).toBe('failing');
    expect(next('failing', FAIL, at(1_000 + FAILING_FOR_MS), failing)).toBe('lapsed');
    expect(FAILING_FOR_MS).toBe(72 * 3_600_000);
  });

  it('sends lapsed and paused back through verified on a pass: they released the name', () => {
    for (const state of ['lapsed', 'paused'] as const) {
      expect(next(state, PASS, at(0), { createdAt: CREATED, failingSince: null }, true), state).toBe('verified');
    }
  });

  it('returns a failing name that is still live to active on a pass: it never released the name', () => {
    const failing = { createdAt: CREATED, failingSince: at(0) };
    expect(next('failing', PASS, at(1_000), failing, true)).toBe('active');
    // A name that failed before it went live has no certificate yet: it waits in verified.
    expect(next('failing', PASS, at(1_000), failing, false)).toBe('verified');
    expect(next('failing', PASS, at(1_000), failing)).toBe('verified');
  });

  it('keeps lapsed and paused on a failure', () => {
    expect(next('lapsed', FAIL, at(0), since)).toBe('lapsed');
    expect(next('paused', FAIL, at(0), since)).toBe('paused');
  });

  it('pauses every claim but an expired one when the feature is gone, pass or not', () => {
    for (const state of ['pending', 'verified', 'active', 'failing', 'lapsed', 'paused'] as const) {
      expect(next(state, GONE, at(0), since), state).toBe('paused');
      expect(next(state, { featured: false, passed: false }, at(0), since), state).toBe('paused');
    }
  });

  it('keeps an expired claim expired until it is removed', () => {
    for (const observation of [PASS, FAIL, GONE]) expect(next('expired', observation, at(0), since)).toBe('expired');
  });

  it('never moves straight to active, and never from an unheld state to failing', () => {
    for (const state of DOMAIN_STATES) {
      for (const observation of [PASS, FAIL, GONE]) {
        const to: DomainState = next(state, observation, at(PENDING_FOR_MS + FAILING_FOR_MS), {
          createdAt: CREATED,
          failingSince: CREATED,
        });
        if (to === 'active') expect(state).toBe('active');
        if (to === 'failing') expect(isHeld(state)).toBe(true);
      }
    }
  });
});
