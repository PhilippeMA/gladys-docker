// -----------------------------------------------------------------------------
// The Gladys device of ONE Docker container.
//
// Unlike a template where the device catalog is a fixed list written by hand,
// every device here is discovered at runtime: the registry builds one of these
// per container the filters select. This file therefore holds no state — it is
// the mapping "a Docker container looks like THIS to Gladys".
//
// Features:
//   On/Off  actuator, starts and stops the container
//   State   read-only text: running, exited, restarting…
//   CPU     read-only percentage (optional, see `collect_stats`)
//   Memory  read-only megabytes  (optional, see `collect_stats`)
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { isRunning } from '../docker/containers.js';

/** Namespace of the external ids of every device of this integration. */
export const DEVICE_TYPE = 'container';

/** Feature keys, kept in one place so discovery and publishing always agree. */
export const FEATURE = {
  ON_OFF: 'on-off',
  STATE: 'state',
  CPU: 'cpu',
  MEMORY: 'memory',
};

/**
 * External ids of one container. The container NAME is the platform id: it is
 * what survives a `docker compose up` that recreates the container with a new
 * id (see containers.js).
 * @param {object} gladys - SDK instance.
 * @param {string} containerName - Docker container name.
 * @returns {{ device: string, feature: Function }} External ids.
 */
export function containerExternalIds(gladys, containerName) {
  return gladys.externalIds(DEVICE_TYPE, containerName);
}

/**
 * Name shown in Gladys. Compose containers get "project · service", which is
 * how their owner thinks of them; everything else keeps its container name.
 * @param {object} container - Normalized container.
 * @returns {string} Device name.
 */
export function containerDeviceName(container) {
  if (container.composeProject && container.composeService) {
    return `${container.composeProject} · ${container.composeService}`;
  }
  return container.name;
}

/**
 * Build the discovery payload of one container.
 * @param {object} gladys - SDK instance.
 * @param {object} container - Normalized container.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @returns {object} Device payload for publishDiscoveredDevices.
 */
export function buildContainerDevice(gladys, container, config) {
  const ids = containerExternalIds(gladys, container.name);

  const features = [
    {
      name: 'On/Off',
      external_id: ids.feature(FEATURE.ON_OFF),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      read_only: false, // actuator: starts and stops the container
      has_feedback: true, // we re-read the daemon after the command
      keep_history: true,
    },
    {
      name: 'State',
      external_id: ids.feature(FEATURE.STATE),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
  ];

  if (config.collect_stats) {
    features.push(
      {
        name: 'CPU',
        external_id: ids.feature(FEATURE.CPU),
        // Docker CPU usage has no dedicated Gladys category; `unknown` is the
        // catch-all the taxonomy provides for exactly this case, and the
        // decimal sensor type plus the percent unit carry the meaning.
        category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        // A container is not capped at one core: `docker stats` reads 200% for
        // one saturating two cores, so the scale goes well beyond 100.
        max: 1600,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Memory',
        external_id: ids.feature(FEATURE.MEMORY),
        category: DEVICE_FEATURE_CATEGORIES.DATA,
        type: DEVICE_FEATURE_TYPES.DATA.SIZE,
        unit: DEVICE_FEATURE_UNITS.MEGABYTE,
        min: 0,
        max: 131072,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    );
  }

  return {
    name: containerDeviceName(container),
    external_id: ids.device,
    poll_frequency: config.poll_frequency,
    // Free key/value metadata, visible on the device page: enough to know which
    // image a device runs without going back to a terminal.
    params: [
      { name: 'DOCKER_CONTAINER_NAME', value: container.name },
      { name: 'DOCKER_IMAGE', value: container.image },
      ...(container.composeProject
        ? [{ name: 'DOCKER_COMPOSE_PROJECT', value: container.composeProject }]
        : []),
      ...(container.composeService
        ? [{ name: 'DOCKER_COMPOSE_SERVICE', value: container.composeService }]
        : []),
    ],
    features,
  };
}

/**
 * The states of one container, ready for `publishStates`. The stats are only
 * included when they could be read: publishing a null would record a wrong 0
 * in the history rather than a gap.
 * @param {object} gladys - SDK instance.
 * @param {object} container - Normalized container.
 * @param {{ cpuPercent: number|null, memoryMb: number|null }} [stats] - Stats readings.
 * @returns {object[]} States for publishStates.
 */
export function buildContainerStates(gladys, container, stats = {}) {
  const ids = containerExternalIds(gladys, container.name);
  const states = [
    {
      device_feature_external_id: ids.feature(FEATURE.ON_OFF),
      state: isRunning(container) ? 1 : 0,
    },
    { device_feature_external_id: ids.feature(FEATURE.STATE), text: container.state },
  ];
  if (typeof stats.cpuPercent === 'number') {
    states.push({ device_feature_external_id: ids.feature(FEATURE.CPU), state: stats.cpuPercent });
  }
  if (typeof stats.memoryMb === 'number') {
    states.push({
      device_feature_external_id: ids.feature(FEATURE.MEMORY),
      state: stats.memoryMb,
    });
  }
  return states;
}
