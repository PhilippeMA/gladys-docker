// -----------------------------------------------------------------------------
// What happens when Gladys polls a container device, or when the user flips its
// On/Off switch. This is the "do the work" side of the integration.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { getContainerStats, startContainer, stopContainer } from './docker/api.js';
import { isRunning } from './docker/containers.js';
import { summarizeStats } from './docker/stats.js';
import { buildContainerStates, FEATURE } from './devices/container.js';

const logger = createLogger({ name: 'commands' });

/**
 * Find the container behind a Gladys device, refreshing the list first so a
 * container created since the last read is found rather than reported missing.
 * @param {object} registry - Registry.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @param {string} externalId - Device external id.
 * @param {object} [options] - Options.
 * @param {boolean} [options.force] - Bypass the list cache.
 * @returns {Promise<object>} Normalized container.
 */
export async function resolveContainer(registry, config, externalId, { force = false } = {}) {
  await registry.list(config, { force });
  const container = registry.findByExternalId(externalId);
  if (!container) {
    // Either the container was removed, or the user's filters no longer select
    // it. Both are worth saying out loud: the device stays in Gladys either way.
    throw new Error(
      `No Docker container matches ${externalId} — it may have been removed, renamed, or excluded by your filters`,
    );
  }
  return container;
}

/**
 * Refresh one container device: its state, and its CPU / memory when the user
 * asked for them.
 *
 * Stats are read only for a running container (a stopped one has none) and a
 * failure to read them is logged, not thrown: losing a CPU reading must not
 * cost us the state we already know.
 * @param {object} gladys - SDK instance.
 * @param {object} registry - Registry.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @param {object} device - Device Gladys asked to poll.
 * @returns {Promise<void>} Resolves once the states are published.
 */
export async function pollContainerDevice(gladys, registry, config, device) {
  const container = await resolveContainer(registry, config, device.external_id);

  let stats = {};
  if (config.collect_stats && isRunning(container)) {
    try {
      stats = summarizeStats(await getContainerStats(registry.getClient(config), container.id));
    } catch (err) {
      logger.warn(`Cannot read the stats of ${container.name}: ${err.message}`);
    }
  }

  await gladys.publishStates(buildContainerStates(gladys, container, stats));
}

/**
 * Run a user command on a container device.
 *
 * `has_feedback` is true on the On/Off feature, so the state published here is
 * the one the daemon reports AFTER the command, not the one that was asked
 * for: a container that dies on startup shows up as off, as it should.
 * @param {object} gladys - SDK instance.
 * @param {object} registry - Registry.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @param {object} params - Command parameters.
 * @param {object} params.device - Target device.
 * @param {object} params.feature - Target feature.
 * @param {number} params.value - Requested value.
 * @returns {Promise<void>} Resolves once the confirmed state is published.
 */
export async function setContainerValue(gladys, registry, config, { device, feature, value }) {
  if (!feature.external_id.endsWith(`:${FEATURE.ON_OFF}`)) {
    throw new Error(`Feature ${feature.external_id} is read-only`);
  }

  const container = await resolveContainer(registry, config, device.external_id);
  const client = registry.getClient(config);
  const shouldRun = Number(value) === 1;

  logger.info(`${shouldRun ? 'Starting' : 'Stopping'} container ${container.name}`);
  if (shouldRun) {
    await startContainer(client, container.id);
  } else {
    await stopContainer(client, container.id, config.stop_timeout);
  }

  // Re-read the daemon: this is the feedback the feature promises.
  const confirmed = await resolveContainer(registry, config, device.external_id, { force: true });
  logger.info(`Container ${confirmed.name} is now ${confirmed.state}`);
  await gladys.publishStates(buildContainerStates(gladys, confirmed));
}
