import { describe, expect, it } from 'vitest';
import {
  captureNotFound,
  catchUrlLimitReached,
  catchUrlNameInvalid,
  catchUrlNameTaken,
  catchUrlNotFound,
  cursorConflict,
  responseBodyTooLarge,
} from '../../../src/hooks/errors.js';
import { toProblem } from '../../../src/problem.js';

describe('hooks-* problems (webhook-capture §3.5)', () => {
  it('each has its status and a code the desktop can switch on', () => {
    expect(
      [
        catchUrlNotFound(),
        captureNotFound(),
        catchUrlNameTaken(),
        catchUrlNameInvalid(),
        catchUrlLimitReached(50),
        responseBodyTooLarge(),
        cursorConflict(),
      ].map((error) => [toProblem(error).status, toProblem(error).body.code]),
    ).toEqual([
      [404, 'hooks-not-found'],
      [404, 'hooks-capture-not-found'],
      [409, 'hooks-name-taken'],
      [400, 'hooks-name-invalid'],
      [409, 'hooks-limit-reached'],
      [400, 'hooks-response-too-large'],
      [400, 'hooks-cursor-conflict'],
    ]);
    expect(catchUrlLimitReached(50).message).toContain('50');
  });
});
