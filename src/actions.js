// -----------------------------------------------------------------------------
// The buttons of the Configuration screen (manifest `actions` field).
//
// Each handler resolves a multi-language message, which Gladys shows under the
// button it belongs to; a thrown error is shown there too, so a failure is
// worth a clear sentence rather than a stack trace.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { getVersion, restartContainer } from './docker/api.js';
import { describeTarget } from './docker/client.js';
import { isRunning } from './docker/containers.js';
import { buildContainerStates } from './devices/container.js';
import { resolveContainer } from './commands.js';

const logger = createLogger({ name: 'actions' });

/** How many container names one message lists before summarizing the rest. */
const MAX_LISTED = 12;

/**
 * Contact the daemon and report what it is and what we see through the filters.
 * The first thing to click when nothing works.
 * @param {object} registry - Registry.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @returns {Promise<object>} Multi-language message.
 */
export async function testConnection(registry, config) {
  const client = registry.getClient(config);
  logger.info(`Testing the connection to ${describeTarget(client.target)}`);

  const version = await getVersion(client);
  const containers = await registry.list(config, { force: true });
  const running = containers.filter(isRunning).length;

  return {
    en:
      `Connected to Docker ${version.Version} (API ${version.ApiVersion}) on ${version.Os}/${version.Arch}. ` +
      `${containers.length} container(s) match your filters, ${running} running.`,
    fr:
      `Connecté à Docker ${version.Version} (API ${version.ApiVersion}) sur ${version.Os}/${version.Arch}. ` +
      `${containers.length} conteneur(s) correspondent à vos filtres, ${running} en fonctionnement.`,
  };
}

/**
 * Show what the inclusion and exclusion filters currently select — the fastest
 * way to understand why a container does or does not show up.
 * @param {object} registry - Registry.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @returns {Promise<object>} Multi-language message.
 */
export async function listMatchingContainers(registry, config) {
  const containers = await registry.list(config, { force: true });
  if (containers.length === 0) {
    return {
      en: 'No container matches your filters. Check the inclusion and exclusion lists.',
      fr: "Aucun conteneur ne correspond à vos filtres. Vérifiez les listes d'inclusion et d'exclusion.",
    };
  }

  const shown = containers
    .slice(0, MAX_LISTED)
    .map((container) => `${container.name} (${container.state})`)
    .join(', ');
  const rest = containers.length - Math.min(containers.length, MAX_LISTED);

  return {
    en: `${containers.length} container(s): ${shown}${rest > 0 ? `, and ${rest} more` : ''}.`,
    fr: `${containers.length} conteneur(s) : ${shown}${rest > 0 ? `, et ${rest} autre(s)` : ''}.`,
  };
}

/**
 * Restart the container behind the device the user picked.
 *
 * The action field declares `"source": "devices"`, so the Configuration screen
 * fills the list with this integration's own devices and hands us the chosen
 * external id — nobody has to copy an identifier by hand.
 * @param {object} gladys - SDK instance.
 * @param {object} registry - Registry.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @param {string} externalId - External id of the chosen device.
 * @returns {Promise<object>} Multi-language message.
 */
export async function restartChosenContainer(gladys, registry, config, externalId) {
  if (!externalId) {
    return {
      en: 'Pick a container first.',
      fr: "Choisissez d'abord un conteneur.",
    };
  }

  const container = await resolveContainer(registry, config, externalId);
  logger.info(`Restarting container ${container.name}`);
  await restartContainer(registry.getClient(config), container.id, config.stop_timeout);

  const confirmed = await resolveContainer(registry, config, externalId, { force: true });
  await gladys.publishStates(buildContainerStates(gladys, confirmed));

  return {
    en: `${confirmed.name} restarted — it is now ${confirmed.state}.`,
    fr: `${confirmed.name} redémarré — il est maintenant « ${confirmed.state} ».`,
  };
}
