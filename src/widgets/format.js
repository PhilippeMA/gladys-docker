// -----------------------------------------------------------------------------
// Turning container data into the short strings a widget card can hold.
//
// The widget vocabulary is deliberately tight — a status row value is 40
// characters, a tile value 12, a tile label 24 — and the Gladys core truncates
// silently past those bounds. Everything that formats for a widget lives here,
// so the limits are respected in one place rather than guessed at each call.
// -----------------------------------------------------------------------------

import { isDegraded, isRunning } from '../docker/containers.js';

/** Bounds of the widget vocabulary we format against (widget-content schema). */
export const WIDGET_LIMITS = {
  STATUS_LABEL: 40,
  STATUS_VALUE: 40,
  TILE_VALUE: 12,
  TILE_LABEL: 24,
  BUTTON_LABEL: 24,
  HEADING: 40,
};

/**
 * Cut a string to a bound without relying on the core's silent truncation, so
 * what we send is what gets shown.
 * @param {string} text - Text to bound.
 * @param {number} max - Maximum length.
 * @returns {string} Bounded text.
 */
export function bound(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Format megabytes the way a human reads them, in at most a tile's worth of
 * characters: "834 MB" under a gigabyte, "2.1 GB" above.
 * @param {number|null|undefined} megabytes - Memory reading.
 * @returns {string|null} Formatted memory, or null when unknown.
 */
export function formatMemory(megabytes) {
  if (typeof megabytes !== 'number' || !Number.isFinite(megabytes)) {
    return null;
  }
  if (megabytes < 1024) {
    return `${Math.round(megabytes)} MB`;
  }
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

/**
 * Format a CPU percentage. Kept to one decimal under 10% — the difference
 * between 0.2% and 1.8% matters on an idle server, the one between 42% and
 * 43% does not.
 * @param {number|null|undefined} percent - CPU reading.
 * @returns {string|null} Formatted percentage, or null when unknown.
 */
export function formatCpu(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    return null;
  }
  return percent < 10 ? `${percent.toFixed(1)} %` : `${Math.round(percent)} %`;
}

/**
 * The semantic color of a container, in the widget vocabulary: green when it
 * runs nominally, orange when it runs badly (restart loop, unhealthy, paused),
 * neutral when it is simply stopped — a stopped container is a state, not a
 * problem, and painting it red would cry wolf on every deliberate shutdown.
 * @param {object} container - Normalized container.
 * @returns {string} A WidgetColor.
 */
export function containerColor(container) {
  if (isDegraded(container)) {
    return 'warning';
  }
  return isRunning(container) ? 'success' : 'neutral';
}

/**
 * The Feather icon that matches a container's state.
 * @param {object} container - Normalized container.
 * @returns {string} Feather icon name.
 */
export function containerIcon(container) {
  if (isDegraded(container)) {
    return 'alert-triangle';
  }
  return isRunning(container) ? 'play-circle' : 'stop-circle';
}

/**
 * The one-line summary of a container for a status row: its readings when it
 * runs, its Docker state when it does not.
 * @param {object} container - Normalized container.
 * @param {{ cpuPercent?: number|null, memoryMb?: number|null }} stats - Last readings.
 * @param {object} labels - Localized words (see widgets/i18n.js).
 * @returns {string} Row value, within the status bound.
 */
export function containerSummary(container, stats, labels) {
  if (!isRunning(container)) {
    return bound(labels.stopped, WIDGET_LIMITS.STATUS_VALUE);
  }
  const parts = [formatCpu(stats.cpuPercent), formatMemory(stats.memoryMb)].filter(Boolean);
  if (parts.length === 0) {
    // Running, but never polled yet: say so rather than show an empty row.
    return bound(labels.running, WIDGET_LIMITS.STATUS_VALUE);
  }
  return bound(parts.join(' · '), WIDGET_LIMITS.STATUS_VALUE);
}
