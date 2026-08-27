// -----------------------------------------------------------------------------
// The Gladys device of ONE Docker container.
//
// Unlike a template where the device catalog is a fixed list written by hand,
// every device here is discovered at runtime: the registry builds one of these
// per container the filters select. This file therefore holds no state — it is
// the mapping "a Docker container looks like THIS to Gladys".
//
// Features:
//   Running  read-only binary: the status badge, and the scene condition
//   State    read-only text: running, exited, restarting…
//   CPU      read-only percentage (optional, see `collect_stats`)
//   Memory   read-only megabytes  (optional, see `collect_stats`)
//   Start / Stop / Restart  push buttons, one click each
//   Action   a select whose choices follow the state (start, or stop+restart)
//
// Why buttons AND a select: Gladys cannot hide a feature depending on a state,
// so the three buttons are always shown (pressing Start on a running container
// is a no-op — Docker answers 304). The select is the one control that CAN
// offer only what makes sense right now, because its `supported_options` are
// re-published with the device.
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
  // Historic key of what used to be an On/Off switch. Kept as-is: changing it
  // would orphan the history of every device already created.
  RUNNING: 'on-off',
  STATE: 'state',
  CPU: 'cpu',
  MEMORY: 'memory',
  START: 'start',
  STOP: 'stop',
  RESTART: 'restart',
  ACTION: 'action',
};

/** The three orders a container understands, as the select's option values. */
export const ACTIONS = { START: 'start', STOP: 'stop', RESTART: 'restart' };

/**
 * The actions that make sense for a container right now — the whole point of
 * the select. A stopped container can only be started; a running one can be
 * stopped or restarted.
 * @param {object} container - Normalized container.
 * @returns {object[]} supported_options for the action feature.
 */
export function availableActions(container) {
  if (isRunning(container)) {
    return [
      { value: ACTIONS.STOP, label: 'Stop', sort_order: 0 },
      { value: ACTIONS.RESTART, label: 'Restart', sort_order: 1 },
    ];
  }
  return [{ value: ACTIONS.START, label: 'Start', sort_order: 0 }];
}

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
      name: 'Running',
      external_id: ids.feature(FEATURE.RUNNING),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      // min and max are NOT optional, on any feature, even a binary one:
      // t_device_feature declares both NOT NULL, so a feature without them is
      // published fine and then refused when the user adds the device.
      min: 0,
      max: 1,
      // A status badge, not a switch: the buttons below do the acting. Being a
      // real feature it keeps its history and stays usable as a scene
      // condition ("if the container is running").
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    // One button per order. All three share the `push` type, which is also what
    // makes Gladys label each row with the name given here instead of the
    // generic category wording.
    ...[
      { key: FEATURE.START, name: 'Start' },
      { key: FEATURE.STOP, name: 'Stop' },
      { key: FEATURE.RESTART, name: 'Restart' },
    ].map(({ key, name }) => ({
      name,
      external_id: ids.feature(key),
      category: DEVICE_FEATURE_CATEGORIES.BUTTON,
      type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
      // The range Gladys gives a push button it can command: pressing sends 1.
      min: 1,
      max: 1,
      read_only: false,
      has_feedback: false,
      // A button has no state worth charting; only its effect matters.
      keep_history: false,
    })),
    {
      name: 'Action',
      external_id: ids.feature(FEATURE.ACTION),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
      min: 0,
      max: 0,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      // The only control that can show just the relevant orders: the core
      // upserts these options on every re-publish of an existing device.
      supported_options: availableActions(container),
    },
    {
      name: 'State',
      external_id: ids.feature(FEATURE.STATE),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
      // A text feature has no numeric range, but the columns are still NOT
      // NULL: 0/0 is the pair Gladys itself assigns to a text/text feature.
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: false,
      // Same reason Gladys defaults text features to no history: a string is
      // not aggregatable, and the On/Off feature already keeps the timeline.
      keep_history: false,
    },
  ];

  // Both stats features deliberately share the `decimal` type. Gladys labels a
  // row with the integration's own feature name ONLY when another feature of
  // the same device carries the same type (shouldDisplayDeviceName); otherwise
  // it uses the i18n wording of the category, which for a borrowed category is
  // the wrong word entirely. Two decimals is what turns "Temperature" into
  // "CPU" and "Size" into "Memory". Give one of them a unique type again and
  // both labels revert — a test pins this.
  if (config.collect_stats) {
    features.push(
      {
        name: 'CPU',
        external_id: ids.feature(FEATURE.CPU),
        // Gladys has no CPU category, so this one is borrowed purely for its
        // icon: `device-temperature-sensor`/`decimal` is the pair the UI draws
        // with a processor chip. The category's own label ("Temperature")
        // never shows, because CPU and Memory share the `decimal` type —
        // see the note above the stats block.
        category: DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
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
        // Borrowed for its icon too, and — just as importantly — for its
        // `decimal` type: sharing it with CPU is what makes Gladys label both
        // rows with the names above. `data`/`size` drew a nicer disk icon, but
        // its type is unique, which left CPU labelled "Temperature".
        category: DEVICE_FEATURE_CATEGORIES.VOLUME_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
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
    // Both are needed, and should_poll is the one that is easy to forget:
    // t_device.should_poll defaults to FALSE, and device.add only schedules a
    // device when `should_poll === true && poll_frequency`. Publishing a
    // frequency alone creates a device Gladys never polls — no state, no CPU,
    // no memory, ever, and nothing in the logs to say so.
    should_poll: true,
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
      device_feature_external_id: ids.feature(FEATURE.RUNNING),
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
