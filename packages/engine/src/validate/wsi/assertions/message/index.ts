/**
 * The WS-I Basic Profile 1.1 message assertion catalogue.
 *
 * The description-level counterpart lives in `../index.ts`. This array is the single source of
 * truth for `runMessageAssertions` and for the message table `scripts/wsi-docs.ts` generates;
 * adding an assertion means adding a module here and nothing else.
 */

import type { WsiMessageAssertion } from '../../types.js';
import { R1001 } from './r1001.js';
import { R1003 } from './r1003.js';
import { R1005 } from './r1005.js';
import { R1006 } from './r1006.js';
import { R1007 } from './r1007.js';
import { R1011 } from './r1011.js';
import { R1012 } from './r1012.js';
import { R1013 } from './r1013.js';
import { R1014 } from './r1014.js';
import { R1015 } from './r1015.js';
import { R1017 } from './r1017.js';
import { R1100 } from './r1100.js';
import { R1101 } from './r1101.js';
import { R1102 } from './r1102.js';
import { R1103 } from './r1103.js';
import { R1107 } from './r1107.js';
import { R1109 } from './r1109.js';
import { R1124 } from './r1124.js';
import { R1132 } from './r1132.js';
import { R1140 } from './r1140.js';
import { R1141 } from './r1141.js';
import { R2113 } from './r2113.js';
import { R2211 } from './r2211.js';

/** Every implemented message assertion, in profile id order. */
export const WSI_MESSAGE_ASSERTIONS: readonly WsiMessageAssertion[] = Object.freeze([
  R1001,
  R1003,
  R1005,
  R1006,
  R1007,
  R1011,
  R1012,
  R1013,
  R1014,
  R1015,
  R1017,
  R1100,
  R1101,
  R1102,
  R1103,
  R1107,
  R1109,
  R1124,
  R1132,
  R1140,
  R1141,
  R2113,
  R2211,
]);

export {
  R1001,
  R1003,
  R1005,
  R1006,
  R1007,
  R1011,
  R1012,
  R1013,
  R1014,
  R1015,
  R1017,
  R1100,
  R1101,
  R1102,
  R1103,
  R1107,
  R1109,
  R1124,
  R1132,
  R1140,
  R1141,
  R2113,
  R2211,
};
