/**
 * The WS-I Basic Profile 1.1 WSDL assertion catalogue.
 *
 * This array is the single source of truth: `runWsdlAssertions` evaluates it in order, and
 * `scripts/wsi-docs.ts` generates `docs/ws-i-assertions.md` from it. Adding an assertion means
 * adding a module here — nothing else needs to know.
 */

import type { WsiAssertion } from '../types.js';
import { R2001 } from './r2001.js';
import { R2002 } from './r2002.js';
import { R2003 } from './r2003.js';
import { R2005 } from './r2005.js';
import { R2101 } from './r2101.js';
import { R2105 } from './r2105.js';
import { R2110 } from './r2110.js';
import { R2111 } from './r2111.js';
import { R2112 } from './r2112.js';
import { R2113 } from './r2113.js';
import { R2201 } from './r2201.js';
import { R2203 } from './r2203.js';
import { R2204 } from './r2204.js';
import { R2205 } from './r2205.js';
import { R2206 } from './r2206.js';
import { R2209 } from './r2209.js';
import { R2210 } from './r2210.js';
import { R2303 } from './r2303.js';
import { R2304 } from './r2304.js';
import { R2401 } from './r2401.js';
import { R2701 } from './r2701.js';
import { R2702 } from './r2702.js';
import { R2705 } from './r2705.js';
import { R2706 } from './r2706.js';
import { R2710 } from './r2710.js';
import { R2716 } from './r2716.js';
import { R2717 } from './r2717.js';
import { R2718 } from './r2718.js';
import { R2720 } from './r2720.js';
import { R2721 } from './r2721.js';
import { R2722 } from './r2722.js';
import { R2801 } from './r2801.js';
import { R2803 } from './r2803.js';

/** Every implemented WSDL assertion, in profile id order. */
export const WSI_WSDL_ASSERTIONS: readonly WsiAssertion[] = Object.freeze([
  R2001,
  R2002,
  R2003,
  R2005,
  R2101,
  R2105,
  R2110,
  R2111,
  R2112,
  R2113,
  R2201,
  R2203,
  R2204,
  R2205,
  R2206,
  R2209,
  R2210,
  R2303,
  R2304,
  R2401,
  R2701,
  R2702,
  R2705,
  R2706,
  R2710,
  R2716,
  R2717,
  R2718,
  R2720,
  R2721,
  R2722,
  R2801,
  R2803,
]);

export {
  R2001,
  R2002,
  R2003,
  R2005,
  R2101,
  R2105,
  R2110,
  R2111,
  R2112,
  R2113,
  R2201,
  R2203,
  R2204,
  R2205,
  R2206,
  R2209,
  R2210,
  R2303,
  R2304,
  R2401,
  R2701,
  R2702,
  R2705,
  R2706,
  R2710,
  R2716,
  R2717,
  R2718,
  R2720,
  R2721,
  R2722,
  R2801,
  R2803,
};
