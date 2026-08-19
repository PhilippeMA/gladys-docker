// -----------------------------------------------------------------------------
// What happens when Gladys polls a container device, or when the user flips its
// On/Off switch. This is the "do the work" side of the integration.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  getContainerStats,
  restartContainer,
  startContainer,
  stopContainer,
} from './docker/api.js';
import { isRunning } from './docker/containers.js';
import { summarizeStats } from './docker/stats.js';
import { ACTIONS, buildContainerStates, FEATURE } from './devices/container.js';

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
 * The action a commanded feature stands for. The three push buttons each mean
 * one order; the select carries the order as its string value; and the historic
 * On/Off switch is still honored so devices created before the buttons existed
 * keep working.
 * @param {object} feature - Commanded feature.
 * @param {unknown} value - Value Gladys sent.
 * @returns {string} One of ACTIONS.
 */
function resolveAction(feature, value) {
  const key = feature.external_id.split(':').pop();

  if (key === FEATURE.START || key === FEATURE.STOP || key === FEATURE.RESTART) {
    return key;
  }
  if (key === FEATURE.ACTION) {
    const action = String(value);
    if (!Object.values(ACTIONS).includes(action)) {
      throw new Error(`Unknown action "${action}"`);
    }
    return action;
  }
  if (key === FEATURE.RUNNING) {
    // Devices created before this feature became a read-only badge still send
    // 0/1 here. Honor it rather than failing on a device the user never
    // re-added.
    return Number(value) === 1 ? ACTIONS.START : ACTIONS.STOP;
  }
  throw new Error(`Feature ${feature.external_id} is read-only`);
}

/**
 * Run one order against a container.
 * @param {object} client - Docker client.
 * @param {object} container - Normalized container.
 * @param {string} action - One of ACTIONS.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @returns {Promise<void>} Resolves once the daemon acknowledged.
 */
async function runAction(client, container, action, config) {
  logger.info(`${action} -> container ${container.name}`);
  if (action === ACTIONS.START) {
    await startContainer(client, container.id);
  } else if (action === ACTIONS.STOP) {
    await stopContainer(client, container.id, config.stop_timeout);
  } else {
    await restartContainer(client, container.id, config.stop_timeout);
  }
}

/**
 * Run a user command on a container device: a push button, a choice in the
 * action select, or the historic On/Off switch.
 *
 * The states published afterwards are the ones the daemon reports AFTER the
 * command, never the ones that were asked for: a container that dies on
 * startup shows up as stopped, as it should.
 * @param {object} gladys - SDK instance.
 * @param {object} registry - Registry.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @param {object} params - Command parameters.
 * @param {object} params.device - Target device.
 * @param {object} params.feature - Target feature.
 * @param {number|string} params.value - Requested value.
 * @returns {Promise<object>} The container as the daemon reports it afterwards.
 */
export async function setContainerValue(gladys, registry, config, { device, feature, value }) {
  const action = resolveAction(feature, value);
  const container = await resolveContainer(registry, config, device.external_id);

  await runAction(registry.getClient(config), container, action, config);

  const confirmed = await resolveContainer(registry, config, device.external_id, { force: true });
  logger.info(`Container ${confirmed.name} is now ${confirmed.state}`);
  await gladys.publishStates(buildContainerStates(gladys, confirmed));
  return confirmed;
}
