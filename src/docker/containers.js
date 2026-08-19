// -----------------------------------------------------------------------------
// From a raw Docker container summary to the shape the rest of the code uses,
// plus the inclusion / exclusion filtering the user configures.
//
// One decision matters here: a container is identified by its NAME, not by its
// id. Ids change every time a container is recreated — `docker compose up` after
// an image update gives you a brand new id for the same service — and an
// external id must stay stable across restarts, otherwise Gladys sees a device
// disappear and a stranger appear every time you update an image.
// -----------------------------------------------------------------------------

/** Docker states that mean "it works, but something is off" (transport badge). */
const DEGRADED_STATES = new Set(['restarting', 'paused', 'dead', 'removing']);

/**
 * Extract the health reported inside the `Status` string of the list endpoint
 * ("Up 3 hours (healthy)"), the only place it appears without inspecting the
 * container one by one.
 * @param {string} status - Raw `Status` field.
 * @returns {string|null} 'healthy', 'unhealthy', 'starting', or null.
 */
function parseHealth(status) {
  const match = /\((healthy|unhealthy|health: starting)\)/i.exec(status ?? '');
  if (!match) {
    return null;
  }
  return match[1].toLowerCase() === 'health: starting' ? 'starting' : match[1].toLowerCase();
}

/**
 * Normalize one raw container summary from `GET /containers/json`.
 * @param {object} raw - Raw container summary.
 * @returns {object} Normalized container.
 */
export function normalizeContainer(raw) {
  const labels = raw.Labels ?? {};
  // Docker returns names with a leading slash, and several of them when the
  // container carries network aliases: the first one is the container name.
  const name =
    (raw.Names ?? []).map((n) => n.replace(/^\//, '')).find((n) => n.length > 0) ?? raw.Id;
  return {
    id: raw.Id,
    name,
    image: raw.Image ?? '',
    state: (raw.State ?? 'unknown').toLowerCase(),
    status: raw.Status ?? '',
    health: parseHealth(raw.Status),
    composeProject: labels['com.docker.compose.project'] ?? null,
    composeService: labels['com.docker.compose.service'] ?? null,
  };
}

/**
 * Whether a container is currently running.
 * @param {object} container - Normalized container.
 * @returns {boolean} True when the state is 'running'.
 */
export function isRunning(container) {
  return container.state === 'running';
}

/**
 * Whether a container runs, but not nominally: restarting in a loop, paused,
 * dead, or failing its own health check. Drives the degraded transport badge.
 * @param {object} container - Normalized container.
 * @returns {boolean} True when the container needs attention.
 */
export function isDegraded(container) {
  return DEGRADED_STATES.has(container.state) || container.health === 'unhealthy';
}

/**
 * Turn one user-typed pattern into a regular expression. `*` matches any run of
 * characters and `?` a single one; everything else is literal, so a name with a
 * dot in it cannot accidentally behave like a wildcard.
 * @param {string} pattern - One pattern, already trimmed.
 * @returns {RegExp} Anchored, case-insensitive matcher.
 */
function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`, 'i');
}

/**
 * Parse a comma-separated filter into matchers, ignoring empty entries so a
 * trailing comma is not a filter that matches nothing.
 * @param {string} filter - Raw comma-separated filter.
 * @returns {RegExp[]} Matchers, empty when the filter is empty.
 */
export function parseFilter(filter) {
  return String(filter ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(patternToRegExp);
}

/**
 * Apply the user's inclusion and exclusion filters to a container name.
 * An empty inclusion filter means "every container"; the exclusion filter is
 * applied last and always wins.
 * @param {string} name - Container name.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @returns {boolean} True when the container must be managed.
 */
export function matchesFilters(name, config) {
  const included = parseFilter(config.name_filter);
  const excluded = parseFilter(config.exclude_filter);
  if (included.length > 0 && !included.some((matcher) => matcher.test(name))) {
    return false;
  }
  return !excluded.some((matcher) => matcher.test(name));
}

/**
 * Normalize a raw container list and keep the ones the filters select, sorted
 * by name so the Discovery tab keeps a stable order between refreshes.
 * @param {object[]} rawContainers - Raw container summaries.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @returns {object[]} Normalized, filtered, sorted containers.
 */
export function selectContainers(rawContainers, config) {
  return rawContainers
    .map(normalizeContainer)
    .filter((container) => matchesFilters(container.name, config))
    .sort((a, b) => a.name.localeCompare(b.name));
}
