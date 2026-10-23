/**
 * The CLI's own report formats, registered beside the engine's `json` (phase 7 spec §3.2): the
 * registry is where `--reporter <id>=<file>` looks an id up.
 */
import type { ReporterContribution } from '@wirebench/engine';
import { renderHtml } from './html.js';
import { renderJunit } from './junit.js';

const BUILTIN = { kind: 'builtin' } as const;

export const CLI_REPORTERS: readonly ReporterContribution[] = [
  { id: 'junit', title: 'JUnit XML', origin: BUILTIN, extension: '.xml', render: (result) => renderJunit(result) },
  { id: 'html', title: 'HTML', origin: BUILTIN, extension: '.html', render: renderHtml },
];
