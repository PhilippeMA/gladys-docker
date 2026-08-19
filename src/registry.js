// -----------------------------------------------------------------------------
// The live picture of the daemon: which containers exist, which Gladys device
// each one is, and whether the daemon answers at all.
//
// Everything the integration does needs the container list, and Gladys polls
// each device independently: with twenty containers, a naive implementation
// would ask the daemon twenty times for the very same list, at the very same
// second. So the list is read once and shared for a few seconds — long enough
// to absorb a poll storm, short enough that a command still reads a fresh
// state right after it ran.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createDockerClient, describeTarget } from './docker/client.js';
import { listContainers } from './docker/api.js';
import { isDegraded, isRunning, selectContainers } from './docker/containers.js';
import { buildContainerDevice, containerExternalIds } from './devices/container.js';
import { isConfigured } from './config.js';

const logger = createLogger({ name: 'registry' });

/** How long a container list is reused before the daemon is asked again. */
export const LIST_CACHE_TTL_MS = 5_000;

/**
 * Build the registry. One instance for the whole process; the configuration is
 * passed to each call rather than captured, so a hot reload needs no rebuild.
 * @param {object} gladys - SDK instance.
 * @param {object} [options] - Options.
 * @param {Function} [options.createClient] - Docker client factory, injectable for tests.
 * @returns {object} Registry.
 */
export function createRegistry(gladys, { createClient = createDockerClient } = {}) {
  let client = null;
  let clientKey = null;
  let containers = [];
  let byExternalId = new Map();
  let pending = null;
  let pendingAt = 0;
  let reachable = false;
  let lastError = null;

  /**
   * The Docker client for the current configuration, rebuilt only when the
   * address or the TLS setting actually changed.
   * @param {Record<string, unknown>} config - Normalized configuration.
   * @returns {object} Docker client.
   */
  function getClient(config) {
    const key = `${config.docker_api_url}|${config.tls_insecure}`;
    if (client === null || key !== clientKey) {
      client = createClient(config);
      clientKey = key;
      logger.info(`Docker API target: ${describeTarget(client.target)}`);
    }
    return client;
  }

  /**
   * Ask the daemon for its container list and rebuild the index.
   * @param {Record<string, unknown>} config - Normalized configuration.
   * @returns {Promise<object[]>} Selected containers.
   */
  async function readFromDaemon(config) {
    if (!isConfigured(config)) {
      throw new Error('No Docker API address configured yet');
    }
    const selected = selectContainers(await listContainers(getClient(config)), config);
    containers = selected;
    byExternalId = new Map(
      selected.map((container) => [containerExternalIds(gladys, container.name).device, container]),
    );
    reachable = true;
    lastError = null;
    logger.debug(`${selected.length} container(s) selected by the filters`);
    return selected;
  }

  /**
   * The container list, from the short-lived cache unless it expired or the
   * caller needs the daemon's word right now (after a start/stop).
   * @param {Record<string, unknown>} config - Normalized configuration.
   * @param {object} [options] - Options.
   * @param {boolean} [options.force] - Bypass the cache.
   * @returns {Promise<object[]>} Selected containers.
   */
  async function list(config, { force = false } = {}) {
    const now = Date.now();
    if (!force && pending !== null && now - pendingAt < LIST_CACHE_TTL_MS) {
      return pending;
    }
    pendingAt = now;
    pending = readFromDaemon(config).catch((err) => {
      // A failed read must not be cached: the next caller has to retry.
      pending = null;
      reachable = false;
      lastError = err;
      throw err;
    });
    return pending;
  }

  return {
    getClient,
    list,

    /** @returns {object[]} The containers of the last successful read. */
    containers() {
      return containers;
    },

    /**
     * Route a Gladys device back to its container.
     * @param {string} externalId - Device external id.
     * @returns {object|undefined} Normalized container, or undefined.
     */
    findByExternalId(externalId) {
      return byExternalId.get(externalId);
    },

    /** @returns {boolean} Whether the last daemon read succeeded. */
    isReachable() {
      return reachable;
    },

    /** @returns {Error|null} The error of the last failed daemon read. */
    lastError() {
      return lastError;
    },

    /**
     * The discovery payload. `include_stopped` filters what is OFFERED here,
     * never what the registry watches: a device the user already created keeps
     * being polled and controlled once its container stops.
     * @param {Record<string, unknown>} config - Normalized configuration.
     * @returns {object[]} Devices for publishDiscoveredDevices.
     */
    buildDiscoveredDevices(config) {
      return containers
        .filter((container) => config.include_stopped || isRunning(container))
        .map((container) => buildContainerDevice(gladys, container, config));
    },

    /**
     * The per-device transport badge. Everything here is local by definition —
     * what the badge really reports is whether we can still see the container,
     * and whether it is in a state worth looking at.
     * @returns {object[]} Entries for publishTransports.
     */
    buildTransportEntries() {
      if (!reachable) {
        // The daemon is gone: every device we know of is out of reach, and the
        // badge says so instead of showing a stale, reassuring green dot.
        return [...byExternalId.keys()].map((external_id) => ({
          external_id,
          transport: DEVICE_TRANSPORTS.UNREACHABLE,
        }));
      }
      return containers.map((container) => {
        const external_id = containerExternalIds(gladys, container.name).device;
        if (!isDegraded(container)) {
          // No `degraded` key: publishing a nominal entry is what clears a
          // previously reported degradation.
          return { external_id, transport: DEVICE_TRANSPORTS.LOCAL };
        }
        return {
          external_id,
          transport: DEVICE_TRANSPORTS.LOCAL,
          degraded: true,
          // Docker's own wording is not translatable, so it is quoted as-is
          // after the localized sentence. Tooltips are capped at 200 chars.
          message: {
            en: `Container state: ${container.state} (${container.status})`.slice(0, 200),
            fr: `État du conteneur : ${container.state} (${container.status})`.slice(0, 200),
          },
        };
      });
    },
  };
}
