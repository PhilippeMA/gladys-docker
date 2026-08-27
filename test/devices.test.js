import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  buildContainerDevice,
  buildContainerStates,
  containerDeviceName,
  containerExternalIds,
  FEATURE,
} from '../src/devices/container.js';
import { normalizeContainer } from '../src/docker/containers.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { rawContainer } from './helpers/fakeDocker.js';
import { assertGladysAcceptsDevices } from './helpers/gladysContract.js';

const gladys = createFakeGladys();
const config = normalizeConfig({ docker_api_url: 'http://docker.test:2375' });
const nginx = normalizeContainer(rawContainer());

test('the external id is built from the container name, not from its id', () => {
  const ids = containerExternalIds(gladys, 'nginx');
  assert.equal(ids.device, 'ext:docker:container:nginx');
  assert.equal(ids.feature(FEATURE.RUNNING), 'ext:docker:container:nginx:on-off');
  // Recreating a container gives it a new id but keeps its name: the device
  // must stay the same one for Gladys.
  const recreated = normalizeContainer(rawContainer({ Id: 'brand-new-id' }));
  assert.equal(containerExternalIds(gladys, recreated.name).device, ids.device);
});

test('a compose container is named "project · service"', () => {
  const container = normalizeContainer(
    rawContainer({
      Names: ['/media-plex-1'],
      Labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
    }),
  );
  assert.equal(containerDeviceName(container), 'media · plex');
});

test('a standalone container keeps its own name', () => {
  assert.equal(containerDeviceName(nginx), 'nginx');
});

test('the poll frequency is passed to Gladys in the milliseconds it expects', () => {
  const device = buildContainerDevice(gladys, nginx, normalizeConfig({ poll_frequency: 30_000 }));
  assert.equal(device.poll_frequency, 30_000);
});

test('a container device shows its state read-only and acts through buttons', () => {
  const device = buildContainerDevice(gladys, nginx, config);
  assert.equal(device.external_id, 'ext:docker:container:nginx');
  assert.equal(device.poll_frequency, config.poll_frequency);

  // The former switch is now a badge: the buttons do the acting, but it keeps
  // its history and stays usable as a scene condition.
  const running = device.features.find((f) => f.external_id.endsWith(`:${FEATURE.RUNNING}`));
  assert.equal(running.category, DEVICE_FEATURE_CATEGORIES.SWITCH);
  assert.equal(running.type, DEVICE_FEATURE_TYPES.SWITCH.BINARY);
  assert.equal(running.read_only, true);
  assert.equal(running.keep_history, true);

  const state = device.features.find((f) => f.external_id.endsWith(`:${FEATURE.STATE}`));
  assert.equal(state.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(state.type, DEVICE_FEATURE_TYPES.TEXT.TEXT);
  assert.equal(state.read_only, true);
});

test('the three orders are commandable push buttons', () => {
  const device = buildContainerDevice(gladys, nginx, config);
  for (const key of [FEATURE.START, FEATURE.STOP, FEATURE.RESTART]) {
    const button = device.features.find((f) => f.external_id.endsWith(`:${key}`));
    assert.ok(button, `${key} button is missing`);
    assert.equal(button.category, DEVICE_FEATURE_CATEGORIES.BUTTON);
    assert.equal(button.type, DEVICE_FEATURE_TYPES.BUTTON.PUSH);
    assert.equal(button.read_only, false);
    // The range Gladys gives a commandable push button.
    assert.deepEqual([button.min, button.max], [1, 1]);
  }
});

test('the action select offers only what the current state allows', () => {
  const running = buildContainerDevice(gladys, nginx, config).features.find((f) =>
    f.external_id.endsWith(`:${FEATURE.ACTION}`),
  );
  assert.equal(running.type, DEVICE_FEATURE_TYPES.TEXT.SELECT);
  assert.equal(running.read_only, false);
  assert.deepEqual(
    running.supported_options.map((o) => o.value),
    ['stop', 'restart'],
    'a running container cannot be started',
  );

  const stopped = normalizeContainer(rawContainer({ State: 'exited', Status: 'Exited (0)' }));
  const options = buildContainerDevice(gladys, stopped, config).features.find((f) =>
    f.external_id.endsWith(`:${FEATURE.ACTION}`),
  ).supported_options;
  assert.deepEqual(
    options.map((o) => o.value),
    ['start'],
    'a stopped container can only be started',
  );
  // The core validates these: a non-empty string label on every option.
  for (const option of options) {
    assert.equal(typeof option.label, 'string');
    assert.ok(option.label.length > 0);
  }
});

test('the stats features are added only when the user asked for them', () => {
  const withStats = buildContainerDevice(gladys, nginx, normalizeConfig({ collect_stats: true }));
  const cpu = withStats.features.find((f) => f.external_id.endsWith(`:${FEATURE.CPU}`));
  const memory = withStats.features.find((f) => f.external_id.endsWith(`:${FEATURE.MEMORY}`));
  assert.equal(cpu.unit, DEVICE_FEATURE_UNITS.PERCENT);
  assert.ok(cpu.max > 100, 'a container can use more than one core');
  assert.equal(memory.unit, DEVICE_FEATURE_UNITS.MEGABYTE);

  const withoutStats = buildContainerDevice(
    gladys,
    nginx,
    normalizeConfig({ collect_stats: false }),
  );
  assert.ok(!withoutStats.features.some((f) => f.external_id.endsWith(`:${FEATURE.CPU}`)));
  assert.ok(!withoutStats.features.some((f) => f.external_id.endsWith(`:${FEATURE.MEMORY}`)));
  assert.equal(withStats.features.length, withoutStats.features.length + 2);
});

test('feature external ids are unique inside a device', () => {
  const device = buildContainerDevice(gladys, nginx, config);
  const ids = device.features.map((f) => f.external_id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the device exposes the image and the compose origin as params', () => {
  const container = normalizeContainer(
    rawContainer({
      Labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
    }),
  );
  const params = Object.fromEntries(
    buildContainerDevice(gladys, container, config).params.map((p) => [p.name, p.value]),
  );
  assert.equal(params.DOCKER_IMAGE, 'nginx:1.27');
  assert.equal(params.DOCKER_CONTAINER_NAME, 'nginx');
  assert.equal(params.DOCKER_COMPOSE_PROJECT, 'media');
  assert.equal(params.DOCKER_COMPOSE_SERVICE, 'plex');
});

test('a standalone container declares no compose params', () => {
  const names = buildContainerDevice(gladys, nginx, config).params.map((p) => p.name);
  assert.ok(!names.includes('DOCKER_COMPOSE_PROJECT'));
});

test('buildContainerStates publishes the on/off and the state text', () => {
  const states = buildContainerStates(gladys, nginx);
  assert.deepEqual(states[0], {
    device_feature_external_id: 'ext:docker:container:nginx:on-off',
    state: 1,
  });
  assert.deepEqual(states[1], {
    device_feature_external_id: 'ext:docker:container:nginx:state',
    text: 'running',
  });
  assert.equal(states.length, 2, 'no stats were provided, none are published');
});

test('a stopped container publishes 0 and its Docker state', () => {
  const stopped = normalizeContainer(rawContainer({ State: 'exited', Status: 'Exited (0)' }));
  const states = buildContainerStates(gladys, stopped);
  assert.equal(states[0].state, 0);
  assert.equal(states[1].text, 'exited');
});

test('unreadable stats are left out instead of being published as 0', () => {
  const states = buildContainerStates(gladys, nginx, { cpuPercent: null, memoryMb: null });
  assert.equal(states.length, 2);

  const withStats = buildContainerStates(gladys, nginx, { cpuPercent: 0, memoryMb: 12.5 });
  assert.equal(withStats.length, 4, 'a genuine 0% is a value, and is published');
  assert.equal(withStats[2].state, 0);
  assert.equal(withStats[3].state, 12.5);
});

test('every feature declares the min and max Gladys stores as NOT NULL', () => {
  // Discovery accepts a feature without them; creating the device does not,
  // so the failure would land on the user at "add device" time.
  for (const collect_stats of [true, false]) {
    const device = buildContainerDevice(gladys, nginx, normalizeConfig({ collect_stats }));
    assertGladysAcceptsDevices([device]);
  }
});

test('the binary and text features use the ranges Gladys assigns to them', () => {
  const device = buildContainerDevice(gladys, nginx, config);
  const onOff = device.features.find((f) => f.external_id.endsWith(`:${FEATURE.RUNNING}`));
  const state = device.features.find((f) => f.external_id.endsWith(`:${FEATURE.STATE}`));

  assert.deepEqual([onOff.min, onOff.max], [0, 1], 'a binary switch spans 0..1');
  assert.deepEqual([state.min, state.max], [0, 0], 'a text feature has no numeric range');
  // A string is not aggregatable, and the On/Off feature already records the
  // running / not-running timeline.
  assert.equal(state.keep_history, false);
});

test('a polled device asks Gladys to actually poll it', () => {
  // should_poll defaults to false in the database: publishing a frequency
  // without it creates a device that is never refreshed, with no error
  // anywhere to explain why every feature stays empty.
  const device = buildContainerDevice(gladys, nginx, config);
  assert.equal(device.should_poll, true);
  assert.equal(device.poll_frequency, config.poll_frequency);
});

test('CPU and Memory share the decimal type, which is what names their rows', () => {
  // Gladys shows the name an integration gave a feature ONLY when a sibling
  // feature carries the same type; otherwise it prints the i18n wording of the
  // category, which for a borrowed category is the wrong word. Give either of
  // these a unique type again and the rows revert to "Temperature" and "Size".
  const device = buildContainerDevice(gladys, nginx, config);
  const cpu = device.features.find((f) => f.external_id.endsWith(`:${FEATURE.CPU}`));
  const memory = device.features.find((f) => f.external_id.endsWith(`:${FEATURE.MEMORY}`));

  assert.equal(cpu.type, DEVICE_FEATURE_TYPES.SENSOR.DECIMAL);
  assert.equal(memory.type, cpu.type, 'a shared type is what makes Gladys use our names');
  assert.equal(cpu.name, 'CPU');
  assert.equal(memory.name, 'Memory');

  // The categories differ: each is borrowed for its icon alone.
  assert.equal(cpu.category, DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR);
  assert.notEqual(memory.category, cpu.category);
});

test('the push buttons rely on the same rule to show their own names', () => {
  const device = buildContainerDevice(gladys, nginx, config);
  const pushTypes = device.features
    .filter((f) => f.type === DEVICE_FEATURE_TYPES.BUTTON.PUSH)
    .map((f) => f.name);
  assert.deepEqual(pushTypes, ['Start', 'Stop', 'Restart']);
  assert.ok(pushTypes.length > 1, 'a lone push button would be labelled "Push button"');
});
