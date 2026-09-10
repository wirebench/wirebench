/**
 * Wire-shaped defaults for test fixtures: the request properties and project settings every
 * `RequestWire`/`ProjectWire` carries, so a test that does not care about them can spread one
 * constant instead of restating twenty booleans.
 */

import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES } from '@wirebench/engine';
import type { ProjectSettingsWire, RequestPropertiesWire } from '../../src/shared/wire-types.js';

/** The default §6.3 request properties, as the renderer mirrors them. */
export const REQUEST_PROPERTIES: RequestPropertiesWire = {
  ...DEFAULT_REQUEST_PROPERTIES,
};

/** The default project settings, as the renderer mirrors them. */
export const PROJECT_SETTINGS: ProjectSettingsWire = { ...DEFAULT_PROJECT_SETTINGS };
