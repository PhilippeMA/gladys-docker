// -----------------------------------------------------------------------------
// Integration configuration.
//
// The values are filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches them
// (`gladys.getConfig()`) and notifies every change (`gladys.onConfigUpdated()`).
//
// This module only holds the defaults and normalizes the received object, so
// the rest of the code never deals with `undefined` nor with a number that
// arrived as a string from the form.
// -----------------------------------------------------------------------------

// The poll frequencies Gladys accepts on a device, in MILLISECONDS. This is a
// closed list mirroring DEVICE_POLL_FREQUENCIES in the Gladys core: anything
// else is refused outright, with the whole discovery payload, when the devices
// are published. Note the ceiling — one minute is as slow as a device can be
// polled — and the unit: a value in seconds looks reasonable and is invalid.
export const GLADYS_POLL_FREQUENCIES = [1000, 2000, 10000, 15000, 30000, 60000];

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (a unit test enforces it).
export const DEFAULT_CONFIG = {
  // No default in the manifest: the address depends on the user's server, the
  // field is `required` and shows a placeholder instead.
  docker_api_url: '',
  tls_insecure: false,
  name_filter: '',
  // Gladys' own containers are excluded by default: controlling the container
  // that runs Gladys from Gladys is a footgun, not a feature.
  exclude_filter: 'gladys*',
  include_stopped: true,
  collect_stats: true,
  poll_frequency: 60_000, // milliseconds, state + sensors of one container
  discovery_frequency: 300, // seconds, re-read of the container list
  stop_timeout: 10, // seconds Docker waits before killing a container
};

/**
 * Read a boolean coming from a generated form (may arrive as 'true'/'false').
 * @param {unknown} value - Raw value.
 * @param {boolean} fallback - Value used when nothing was provided.
 * @returns {boolean} Normalized boolean.
 */
function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return Boolean(value);
}

/**
 * Read a number coming from a generated form, clamped into the range the
 * manifest declares — a value out of range would only be discovered later, as
 * a daemon hammered every second or a device never refreshed.
 * @param {unknown} value - Raw value.
 * @param {number} fallback - Value used when nothing usable was provided.
 * @param {number} min - Lower bound, as declared in the manifest.
 * @param {number} max - Upper bound, as declared in the manifest.
 * @returns {number} Normalized number.
 */
function toNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Read the device poll frequency, which Gladys only accepts as one of a closed
 * list of millisecond values. A value outside the list falls back to the
 * default instead of being forwarded: Gladys rejects the ENTIRE discovery
 * payload over one bad frequency, so a single odd value would cost every
 * device of the integration.
 * @param {unknown} value - Raw value, a string when it comes from the form.
 * @returns {number} A frequency Gladys accepts, in milliseconds.
 */
function toPollFrequency(value) {
  const parsed = Number(value);
  return GLADYS_POLL_FREQUENCIES.includes(parsed) ? parsed : DEFAULT_CONFIG.poll_frequency;
}

/**
 * Merge the user configuration with the defaults and force the types.
 * @param {Record<string, unknown>} raw - Configuration returned by the SDK.
 * @returns {Record<string, unknown>} Normalized configuration.
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    docker_api_url: String(raw.docker_api_url ?? DEFAULT_CONFIG.docker_api_url).trim(),
    tls_insecure: toBoolean(raw.tls_insecure, DEFAULT_CONFIG.tls_insecure),
    name_filter: String(raw.name_filter ?? DEFAULT_CONFIG.name_filter),
    exclude_filter: String(raw.exclude_filter ?? DEFAULT_CONFIG.exclude_filter),
    include_stopped: toBoolean(raw.include_stopped, DEFAULT_CONFIG.include_stopped),
    collect_stats: toBoolean(raw.collect_stats, DEFAULT_CONFIG.collect_stats),
    poll_frequency: toPollFrequency(raw.poll_frequency),
    discovery_frequency: toNumber(
      raw.discovery_frequency,
      DEFAULT_CONFIG.discovery_frequency,
      60,
      3600,
    ),
    stop_timeout: toNumber(raw.stop_timeout, DEFAULT_CONFIG.stop_timeout, 0, 300),
  };
}

/**
 * Whether the integration holds enough configuration to reach a daemon.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @returns {boolean} True when the Docker API address is set.
 */
export function isConfigured(config) {
  return config.docker_api_url.length > 0;
}
