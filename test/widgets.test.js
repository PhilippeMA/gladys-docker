import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContainersContent, sortContainers } from '../src/widgets/containersWidget.js';
import { buildContainerContent } from '../src/widgets/containerWidget.js';
import { containerSummary, formatCpu, formatMemory } from '../src/widgets/format.js';
import { labelsFor, restartedMessage } from '../src/widgets/i18n.js';
import { createRegistry } from '../src/registry.js';
import { normalizeConfig } from '../src/config.js';
import { normalizeContainer } from '../src/docker/containers.js';
import { FEATURE } from '../src/devices/container.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeDockerClient, rawContainer } from './helpers/fakeDocker.js';
import { assertGladysRendersContent, componentsOfType } from './helpers/widgetContract.js';

const config = normalizeConfig({ docker_api_url: 'http://docker.test:2375' });

/**
 * Build a registry over a scripted daemon, with optional remembered readings.
 * @param {object[]} containers - Raw container summaries.
 * @param {object} [stats] - Readings to remember, keyed by container name.
 * @returns {{ gladys: object, registry: object }} Test rig.
 */
function createRig(containers, stats = {}) {
  const gladys = createFakeGladys();
  const client = createFakeDockerClient({ containers });
  const registry = createRegistry(gladys, { createClient: () => client });
  for (const [name, reading] of Object.entries(stats)) {
    registry.rememberStats(name, reading);
  }
  return { gladys, registry };
}

const RUNNING = [
  rawContainer({ Id: '1', Names: ['/nginx'] }),
  rawContainer({ Id: '2', Names: ['/redis'] }),
  rawContainer({ Id: '3', Names: ['/backup'], State: 'exited', Status: 'Exited (0)' }),
];

// --- the overview -----------------------------------------------------------

test('the overview renders exactly as Gladys would show it', async () => {
  const { registry } = createRig(RUNNING, {
    nginx: { cpuPercent: 12.4, memoryMb: 256 },
    redis: { cpuPercent: 1.2, memoryMb: 64 },
  });

  const content = await buildContainersContent(registry, config, { settings: {}, language: 'fr' });
  assertGladysRendersContent(content, 'containers');
});

test('the overview counts the containers and adds up their readings', async () => {
  const { registry } = createRig(RUNNING, {
    nginx: { cpuPercent: 12.4, memoryMb: 256 },
    redis: { cpuPercent: 1.2, memoryMb: 64 },
  });

  const content = await buildContainersContent(registry, config, { settings: {}, language: 'en' });
  const tiles = componentsOfType(content, 'value');
  const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t.value]));

  assert.equal(byLabel.Containers, 3);
  assert.equal(byLabel.Running, 2);
  assert.equal(byLabel.Stopped, 1);
  assert.equal(byLabel['Total CPU'], 13.6);
  assert.equal(byLabel['Total memory'], '320 MB');
});

test('one row per container, with its readings or its state', async () => {
  const { registry } = createRig(RUNNING, { nginx: { cpuPercent: 12.4, memoryMb: 256 } });

  const content = await buildContainersContent(registry, config, { settings: {}, language: 'en' });
  const [status] = componentsOfType(content, 'status');
  const byLabel = Object.fromEntries(status.items.map((i) => [i.label, i.value]));

  // 12.4 reads as "12 %": past ten percent the decimal is noise (formatCpu).
  assert.equal(byLabel.nginx, '12 % · 256 MB');
  assert.equal(
    byLabel.backup,
    'Stopped',
    'a stopped container shows its state, not a stale reading',
  );
  assert.equal(byLabel.redis, 'Running', 'running but never polled yet');
});

test('a degraded container takes the fifth tile and offers a restart button', async () => {
  const { registry } = createRig([
    rawContainer({ Id: '1', Names: ['/nginx'] }),
    rawContainer({
      Id: '2',
      Names: ['/flaky'],
      State: 'restarting',
      Status: 'Restarting (1) 2 seconds ago',
    }),
  ]);

  const content = await buildContainersContent(registry, config, { settings: {}, language: 'en' });
  assertGladysRendersContent(content, 'containers (degraded)');

  const attention = componentsOfType(content, 'value').find((t) => t.label === 'Needs attention');
  assert.equal(attention.value, 1);
  assert.equal(attention.color, 'warning');

  const [button] = componentsOfType(content, 'button');
  assert.equal(button.action.key, 'restart_container');
  assert.deepEqual(button.action.params, { container: 'flaky' });
  assert.equal(button.action.confirm, true, 'a restart is confirmed before it runs');
});

test('no button when several containers are wrong: there is no single target', async () => {
  const { registry } = createRig([
    rawContainer({ Id: '1', Names: ['/a'], State: 'restarting', Status: 'Restarting (1)' }),
    rawContainer({ Id: '2', Names: ['/b'], State: 'dead', Status: 'Dead' }),
  ]);

  const content = await buildContainersContent(registry, config, { settings: {}, language: 'en' });
  assert.equal(componentsOfType(content, 'button').length, 0);
});

test('past ten containers the last row says how many are hidden', async () => {
  const many = Array.from({ length: 14 }, (_, i) =>
    rawContainer({ Id: `id-${i}`, Names: [`/app-${String(i).padStart(2, '0')}`] }),
  );
  const { registry } = createRig(many);

  const content = await buildContainersContent(registry, config, {
    settings: { sort: 'name' },
    language: 'en',
  });
  assertGladysRendersContent(content, 'containers (overflow)');

  const [status] = componentsOfType(content, 'status');
  assert.equal(status.items.length, 10, 'the status component caps at ten rows');
  assert.equal(status.items.at(-1).label, '+5 more', '9 shown, 5 accounted for');
});

test('a very long container name is shortened by us, not truncated by Gladys', async () => {
  // Docker names can be long ("myproject-really-long-service-name-1"); the
  // core would cut the row label silently at 40 characters.
  const longName = 'a-really-long-compose-service-name-that-goes-on-forever';
  const { registry } = createRig([rawContainer({ Names: [`/${longName}`] })]);

  const content = await buildContainersContent(registry, config, { settings: {}, language: 'en' });
  assertGladysRendersContent(content, 'containers (long name)');

  const [status] = componentsOfType(content, 'status');
  assert.ok(status.items[0].label.length <= 40);
  assert.ok(status.items[0].label.endsWith('…'), 'shortened on our side, with an ellipsis');
});

test('the containers setting narrows the list to the chosen devices', async () => {
  const { registry } = createRig(RUNNING);
  await registry.list(config);

  const content = await buildContainersContent(registry, config, {
    settings: { containers: [registry.externalIdOf('redis')] },
    language: 'en',
  });
  const [status] = componentsOfType(content, 'status');
  assert.deepEqual(
    status.items.map((i) => i.label),
    ['redis'],
  );
});

test('an unreachable daemon says so instead of rendering an empty card', async () => {
  const gladys = createFakeGladys();
  const client = createFakeDockerClient({ failWith: new Error('connect ECONNREFUSED') });
  const registry = createRegistry(gladys, { createClient: () => client });

  const content = await buildContainersContent(registry, config, { settings: {}, language: 'fr' });
  assertGladysRendersContent(content, 'containers (unreachable)');
  assert.match(componentsOfType(content, 'text')[0].text, /injoignable/);
});

test('filters matching nothing produce an explicit empty state', async () => {
  const { registry } = createRig([]);
  const content = await buildContainersContent(registry, config, { settings: {}, language: 'en' });
  assert.match(componentsOfType(content, 'text')[0].text, /No container matches/);
});

// --- sorting ----------------------------------------------------------------

test('the default order surfaces what deserves a look', () => {
  const containers = [
    normalizeContainer(rawContainer({ Names: ['/zulu'] })),
    normalizeContainer(rawContainer({ Names: ['/alpha'], State: 'exited', Status: 'Exited (0)' })),
    normalizeContainer(
      rawContainer({ Names: ['/flaky'], State: 'restarting', Status: 'Restarting (1)' }),
    ),
  ];
  const { registry } = createRig([]);

  assert.deepEqual(
    sortContainers(containers, registry, 'state').map((c) => c.name),
    ['flaky', 'alpha', 'zulu'],
    'degraded, then stopped, then running',
  );
  assert.deepEqual(
    sortContainers(containers, registry, 'name').map((c) => c.name),
    ['alpha', 'flaky', 'zulu'],
  );
});

test('sorting by a reading puts the biggest first and the unknown last', () => {
  const containers = ['a', 'b', 'c'].map((n) =>
    normalizeContainer(rawContainer({ Names: [`/${n}`] })),
  );
  const { registry } = createRig([], {
    a: { cpuPercent: 3, memoryMb: 10 },
    b: { cpuPercent: 42, memoryMb: 5 },
  });

  assert.deepEqual(
    sortContainers(containers, registry, 'cpu').map((c) => c.name),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    sortContainers(containers, registry, 'memory').map((c) => c.name),
    ['a', 'b', 'c'],
  );
});

// --- the single container ---------------------------------------------------

test('the container card renders exactly as Gladys would show it', async () => {
  const { gladys, registry } = createRig(RUNNING);
  await registry.list(config);

  const content = await buildContainerContent(gladys, registry, config, {
    settings: { device: registry.externalIdOf('nginx') },
    language: 'fr',
  });
  assertGladysRendersContent(content, 'container');
});

test('its tiles and buttons bind to the features of the chosen container', async () => {
  const { gladys, registry } = createRig(RUNNING);
  await registry.list(config);
  const deviceId = registry.externalIdOf('nginx');

  const content = await buildContainerContent(gladys, registry, config, {
    settings: { device: deviceId },
    language: 'en',
  });

  const tiles = componentsOfType(content, 'value');
  assert.deepEqual(
    tiles.map((t) => t.device_feature),
    [`${deviceId}:${FEATURE.CPU}`, `${deviceId}:${FEATURE.MEMORY}`],
    'live tiles follow the published states, no daemon call',
  );

  const buttons = componentsOfType(content, 'button');
  assert.deepEqual(
    buttons.map((b) => b.device_feature),
    [
      `${deviceId}:${FEATURE.START}`,
      `${deviceId}:${FEATURE.STOP}`,
      `${deviceId}:${FEATURE.RESTART}`,
    ],
  );
  for (const button of buttons) {
    assert.equal(button.value, 1, 'a push feature is commanded with 1');
  }
});

test('the card drops its tiles when stats collection is off', async () => {
  const { gladys, registry } = createRig(RUNNING);
  await registry.list(config);

  const content = await buildContainerContent(
    gladys,
    registry,
    normalizeConfig({ ...config, collect_stats: false }),
    { settings: { device: registry.externalIdOf('nginx') }, language: 'en' },
  );
  assertGladysRendersContent(content, 'container (no stats)');
  assert.equal(componentsOfType(content, 'value').length, 0);
  assert.equal(componentsOfType(content, 'button').length, 3, 'the controls stay');
});

test('a widget dropped without a container tells the user what to do', async () => {
  const { gladys, registry } = createRig(RUNNING);
  const content = await buildContainerContent(gladys, registry, config, {
    settings: {},
    language: 'en',
  });
  assert.match(componentsOfType(content, 'text')[0].text, /Pick a container/);
});

test('a container that disappeared says so rather than showing a dead card', async () => {
  const { gladys, registry } = createRig(RUNNING);
  await registry.list(config);
  const content = await buildContainerContent(gladys, registry, config, {
    settings: { device: 'ext:docker:container:ghost' },
    language: 'en',
  });
  assert.match(componentsOfType(content, 'text')[0].text, /no longer exists/);
});

// --- formatting -------------------------------------------------------------

test('readings are formatted to fit, and to stay readable', () => {
  assert.equal(formatCpu(0.23), '0.2 %', 'the difference matters on an idle server');
  assert.equal(formatCpu(42.6), '43 %', 'past ten percent the decimal is noise');
  assert.equal(formatCpu(null), null);
  assert.equal(formatMemory(834), '834 MB');
  assert.equal(formatMemory(2150), '2.1 GB');
  assert.equal(formatMemory(undefined), null);
});

test('a row summary never exceeds what a status row holds', () => {
  const labels = labelsFor('en');
  const container = normalizeContainer(rawContainer());
  const summary = containerSummary(container, { cpuPercent: 1234.5, memoryMb: 999999 }, labels);
  assert.ok(summary.length <= 40, `too long: ${summary}`);
});

test('both languages are served, and an unknown one falls back to English', () => {
  assert.equal(labelsFor('fr').running, 'En marche');
  assert.equal(labelsFor('fr-BE').running, 'En marche', 'a region suffix is tolerated');
  assert.equal(labelsFor('de').running, 'Running');
  assert.equal(labelsFor(undefined).running, 'Running');
});

test('an action toast carries every language, since the handler is told none', () => {
  // onWidgetAction receives no `language`, unlike onWidgetGet: the core picks
  // from the multi-language object, with `en` as the mandatory fallback.
  const message = restartedMessage('nginx');
  assert.ok(message.en.includes('nginx'));
  assert.ok(message.fr.includes('nginx'));
  for (const text of Object.values(message)) {
    assert.ok(text.length <= 200, 'a toast is capped at 200 characters per language');
  }
});
