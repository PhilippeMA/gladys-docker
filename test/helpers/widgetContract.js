// -----------------------------------------------------------------------------
// The widget-content contract, checked with the core's own validator.
//
// The SDK ships `validateWidgetContent`: the same check its dev mode runs
// before sending, mirroring the published widget-content vocabulary AND the
// content budget the core enforces on top of it (8 components, 1 focal, 6
// tiles, 2 texts, 1 status, 4 buttons). It reports what Gladys would DROP or
// TRUNCATE — silently, in production, leaving a card that renders "fine" minus
// what it refused.
//
// Treating any of those reports as a test failure is the point: a truncated
// label or a dropped button is a bug we would otherwise only see on a
// dashboard.
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';

/**
 * Assert that Gladys would render a widget content exactly as it was built.
 * @param {object} content - The content an onWidgetGet handler resolves.
 * @param {string} [what] - Name of the widget, for the failure message.
 */
export function assertGladysRendersContent(content, what = 'widget') {
  const problems = validateWidgetContent(content);
  assert.deepEqual(
    problems,
    [],
    `${what}: Gladys would change this content —\n  ${problems.join('\n  ')}`,
  );
}

/**
 * The components of one type in a content, in the order they were built.
 * @param {object} content - A widget content.
 * @param {string} type - Component type.
 * @returns {object[]} Matching components.
 */
export function componentsOfType(content, type) {
  return content.components.filter((component) => component.type === type);
}
