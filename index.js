// -----------------------------------------------------------------------------
// Entry point of the Gladys Docker integration.
//
// Role of this file: wire the SDK to the registry (src/registry.js) and to the
// handlers (src/commands.js, src/actions.js). It holds no Docker logic:
//   1. it instantiates the SDK (connection, auth, reconnection: handled);
//   2. it registers the event handlers BEFORE connect();
//   3. it connects, publishes the containers it found, and keeps that list
//      fresh so a container created later shows up on its own.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { isConfigured, normalizeConfig } from './src/config.js';
import { createRegistry } from './src/registry.js';
import { pollContainerDevice, setContainerValue } from './src/commands.js';
import { listMatchingContainers, restartChosenContainer, testConnection } from './src/actions.js';

const gladys = new GladysIntegration();
const registry = createRegistry(gladys);

// Current configuration (hot-reloaded through onConfigUpdated).
let config = normalizeConfig();

// Handle of the loop that re-reads the container list (see startDiscoveryLoop).
let discoveryTimer = null;

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> reading the container list');
  await refreshDevices();
});

// --- Command: a push button, the action select, or the legacy switch ---------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  // Throwing acks the command as failed, and Gladys shows the reason.
  await setContainerValue(gladys, registry, config, { device, feature, value });
  // The action select only offers the orders that make sense for the current
  // state, so its options have to follow what just happened.
  await republishDevices();
});

// --- Polling: Gladys asks to refresh one container ---------------------------
gladys.onPoll(async (device) => {
  await pollContainerDevice(gladys, registry, config, device);
});

// --- A device was just added from the Discovery tab --------------------------
// Without this, a brand new device sits empty until the first scheduled poll —
// up to a minute of a dashboard showing nothing at all.
gladys.onDeviceCreated(async (device) => {
  logger.info(`onDeviceCreated -> ${device.external_id}, publishing a first reading`);
  try {
    await pollContainerDevice(gladys, registry, config, device);
  } catch (err) {
    logger.error(`First reading of ${device.external_id} failed: ${err.message}`);
  }
});

// --- Manifest actions: the buttons of the Configuration screen ---------------
gladys.onAction('test_connection', () => testConnection(registry, config));
gladys.onAction('list_containers', () => listMatchingContainers(registry, config));
gladys.onAction('restart_container', async (fields) => {
  const message = await restartChosenContainer(gladys, registry, config, fields.device);
  await republishDevices();
  return message;
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // The address, the filters and the poll frequency all change what the devices
  // are: re-read the daemon and re-publish. publishDiscoveredDevices is
  // idempotent (upsert by external_id), so this never duplicates anything.
  await refreshDevices();
  startDiscoveryLoop();
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under the `gladys-sdk` name):
// these handlers only run the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    await refreshDevices();
    startDiscoveryLoop();
    await publishCreatedDeviceStates();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
  }
});

gladys.on('disconnected', () => {
  stopDiscoveryLoop();
});

/**
 * Re-read the daemon, publish the containers it holds, refresh the transport
 * badges, and report the application-level connection status.
 *
 * NOTHING is allowed to escape this function. It is the only place that calls
 * setConnectionStatus, so an exception thrown on the way out would leave the
 * Configuration screen showing whatever it last displayed — an old failure
 * message, long after the cause was fixed. Every path below therefore ends on
 * a status: success, or a failure that says which half broke.
 * @returns {Promise<void>} Resolves once Gladys has been updated.
 */
async function refreshDevices() {
  if (!isConfigured(config)) {
    logger.warn('No Docker API address configured yet — waiting for the configuration');
    await reportStatus(false, {
      en: 'Set the address of your Docker API to get started.',
      fr: 'Renseignez l’adresse de votre API Docker pour commencer.',
    });
    return;
  }

  try {
    await registry.list(config, { force: true });
    const devices = registry.buildDiscoveredDevices(config);
    logger.info(`Publishing ${devices.length} container device(s)`);
    await gladys.publishDiscoveredDevices(devices);
    await publishTransports();
    await reportStatus(true);
  } catch (err) {
    // Two very different failures land here, and telling them apart is the
    // difference between "check your Docker setup" and "this is our bug":
    // either the daemon did not answer, or Gladys refused what we published.
    const daemonFailed = !registry.isReachable();
    logger.error(
      daemonFailed
        ? `Cannot read the container list: ${err.message}`
        : `Gladys refused the container devices: ${err.message}`,
    );
    // Devices already created keep existing; their badge turns unreachable
    // when the daemon is the problem.
    await publishTransports().catch(() => {});
    await reportStatus(
      false,
      daemonFailed
        ? {
            en: `Cannot reach the Docker API: ${err.message}`.slice(0, 200),
            fr: `Impossible de joindre l’API Docker : ${err.message}`.slice(0, 200),
          }
        : {
            en: `Docker containers found, but Gladys refused them: ${err.message}`.slice(0, 200),
            fr: `Conteneurs Docker trouvés, mais Gladys les a refusés : ${err.message}`.slice(
              0,
              200,
            ),
          },
    );
  }
}

/**
 * Re-publish the device list without touching the connection status.
 *
 * Only the action select needs this: the core upserts `supported_options` onto
 * the already-created devices on every re-publish, which is how the select
 * stops offering "Start" the moment the container is running. A failure here
 * costs a stale menu, not a broken command, so it is logged and swallowed.
 * @returns {Promise<void>} Resolves once re-published.
 */
async function republishDevices() {
  try {
    await gladys.publishDiscoveredDevices(registry.buildDiscoveredDevices(config));
  } catch (err) {
    logger.warn(`Cannot refresh the action choices: ${err.message}`);
  }
}

/**
 * Publish a fresh reading for every container device the user has already
 * created, so a restart of the integration does not leave the dashboard empty
 * until the next scheduled poll.
 *
 * Sequential on purpose: each reading costs the daemon about a second when the
 * stats are collected, and firing twenty of them at once is how you make Docker
 * unresponsive at the exact moment the user is looking at it. A device that
 * fails is logged and skipped — one unreadable container must not stop the rest.
 * @returns {Promise<void>} Resolves once every device has been attempted.
 */
async function publishCreatedDeviceStates() {
  const created = await gladys.getDevices();
  const ours = created.filter((device) => registry.findByExternalId(device.external_id));
  if (ours.length === 0) {
    return;
  }
  logger.info(`Publishing a first reading for ${ours.length} existing device(s)`);
  for (const device of ours) {
    try {
      await pollContainerDevice(gladys, registry, config, device);
    } catch (err) {
      logger.warn(`Cannot read ${device.external_id}: ${err.message}`);
    }
  }
}

/**
 * Publish the per-device transport badges, when there is anything to say.
 * @returns {Promise<void>} Resolves once published.
 */
async function publishTransports() {
  const entries = registry.buildTransportEntries();
  if (entries.length > 0) {
    await gladys.publishTransports(entries);
  }
}

/**
 * Report the application-level status shown in the Configuration screen. It is
 * distinct from the container state machine: this integration can be RUNNING
 * and still unable to reach the Docker daemon it manages.
 * @param {boolean} connected - Whether the daemon answered.
 * @param {object} [message] - Multi-language reason, when it did not.
 * @returns {Promise<void>} Resolves once reported.
 */
async function reportStatus(connected, message) {
  await gladys.setConnectionStatus(connected, message).catch((err) => {
    logger.error('Cannot report the connection status', err);
  });
}

/**
 * Re-read the container list on a timer, so containers created (or removed)
 * after installation appear (or stop being offered) without the user having to
 * click anything. Restarted whenever the interval may have changed.
 */
function startDiscoveryLoop() {
  stopDiscoveryLoop();
  discoveryTimer = setInterval(() => {
    refreshDevices().catch((err) => logger.error('Discovery refresh failed', err));
  }, config.discovery_frequency * 1000);
  // Do not hold the process alive for the sake of the timer alone.
  discoveryTimer.unref?.();
}

/** Stop the discovery loop, on disconnection or shutdown. */
function stopDiscoveryLoop() {
  if (discoveryTimer !== null) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopDiscoveryLoop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Docker integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
