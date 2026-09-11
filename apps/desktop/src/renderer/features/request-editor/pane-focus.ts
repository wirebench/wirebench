/**
 * ⇧Tab — move focus between the request and response editors, the design's one-key way to get
 * from what you are sending to what came back without reaching for the mouse.
 */

import { getActiveRequestEditor } from '../../editor/active-request-editor.js';
import { getActiveResponseEditor } from '../../editor/active-response-editor.js';

/**
 * Focuses the pane that is not focused now: response when the caret is in the request editor,
 * request otherwise. With only one of the two mounted (no response yet, or the response pane
 * showing a non-XML view) focus lands on whichever exists.
 *
 * @returns `true` when an editor was focused.
 */
export function focusOtherPane(): boolean {
  const request = getActiveRequestEditor();
  const response = getActiveResponseEditor();
  // From anywhere that is not one of the two editors (the sidebar, an inspector field) the
  // first ⇧Tab puts the caret back in the request editor rather than jumping to the response.
  const target =
    response?.hasTextFocus() === true ? request : request?.hasTextFocus() === true ? (response ?? request) : request;
  const resolved = target ?? response;
  if (resolved === undefined) {
    return false;
  }
  resolved.focus();
  return true;
}
