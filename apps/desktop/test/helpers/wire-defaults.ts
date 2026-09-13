/**
 * Wire-shaped defaults for test fixtures: the request properties and project settings every
 * `RequestWire`/`ProjectWire` carries, so a test that does not care about them can spread one
 * constant instead of restating twenty booleans.
 */

import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES } from '@wirebench/engine';
import type { ProjectSettingsWire, ProjectWire, RequestPropertiesWire } from '../../src/shared/wire-types.js';

/** The default §6.3 request properties, as the renderer mirrors them. */
export const REQUEST_PROPERTIES: RequestPropertiesWire = {
  ...DEFAULT_REQUEST_PROPERTIES,
};

/** The default project settings, as the renderer mirrors them. */
export const PROJECT_SETTINGS: ProjectSettingsWire = { ...DEFAULT_PROJECT_SETTINGS };

/**
 * The REST halves of a `ProjectWire`, empty. Spread into a fixture that is about SOAP so the
 * snapshot stays complete without every such test having to mention APIs it does not use.
 */
export const NO_REST: Pick<ProjectWire, 'apis' | 'folders' | 'restRequests'> = {
  apis: [],
  folders: [],
  restRequests: [],
};
