/** Every `audit-*` problem (audit-log spec §3.4). */
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

export const cursorInvalid = (): WirebenchError =>
  problem('audit-cursor-invalid', 'The page cursor is not one this server issued. Start from the first page.', 400);
