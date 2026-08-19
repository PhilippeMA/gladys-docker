import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createRegistry, LIST_CACHE_TTL_MS } from '../src/registry.js';
import { GLADYS_POLL_FREQUENCIES, normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeDockerClient, rawContainer } from './helpers/fakeDocker.js';
import { assertGladysAcceptsDevices } from './helpers/gladysContract.js';

/**
 * Build a registry wired to a fake daemon.
 * @param {object} [options] - Options passed to the fake Docker client.
 * @returns {{ gladys: object, registry: object, client: object }} Test rig.
 */
function createRig(options = {}) {
  const gladys = createFakeGladys();
  const client = createFakeDockerClient(options);
  const registry = createRegistry(gladys, { createClient: () => client });
  return { gladys, registry, client };
}

const config = normalizeConfig({ docker_api_url: 'http://docker.test:2375' });

test('list reads the daemon and indexes the containers by external id', async () => {
  const { registry } = createRig({
    containers: [rawContainer({ Names: ['/nginx'] }), rawContainer({ Id: '2', Names: ['/redis'] })],
  });

  const containers = await registry.list(config);
  assert.deepEqual(
    containers.map((c) => c.name),
    ['nginx', 'redis'],
  );
  assert.equal(registry.findByExternalId('ext:docker:container:redis').id, '2');
  assert.equal(registry.findByExternalId('ext:docker:container:ghost'), undefined);
  assert.equal(registry.isReachable(), true);
});

test('the list is shared between callers instead of hammering the daemon', async () => {
  const { registry, client } = createRig({ containers: [rawContainer()] });

  await Promise.all([registry.list(config), registry.list(config), registry.list(config)]);
  assert.equal(client.calls.length, 1, 'a poll storm costs one daemon call');

  await registry.list(config, { force: true });
  assert.equal(client.calls.length, 2, 'a command reads a fresh list');
});

test('a failed read is not cached, so the next caller retries', async () => {
  const { registry, client } = createRig({ failWith: new Error('connect ECONNREFUSED') });

  await assert.rejects(() => registry.list(config), /ECONNREFUSED/);
  assert.equal(registry.isReachable(), false);
  assert.match(registry.lastError().message, /ECONNREFUSED/);

  await assert.rejects(() => registry.list(config), /ECONNREFUSED/);
  assert.equal(client.calls.length, 2, 'the second call reached the daemon again');
});

test('the cache window is short enough for a command to see its own effect', () => {
  assert.ok(LIST_CACHE_TTL_MS <= 10_000);
});

test('list refuses to run before the address is configured', async () => {
  const { registry } = createRig({ containers: [] });
  await assert.rejects(() => registry.list(normalizeConfig()), /No Docker API address/);
});

test('discovery offers every container when stopped ones are welcome', async () => {
  const { registry } = createRig({
    containers: [
      rawContainer({ Names: ['/nginx'] }),
      rawContainer({ Id: '2', Names: ['/backup'], State: 'exited', Status: 'Exited (0)' }),
    ],
  });
  await registry.list(config);

  const devices = registry.buildDiscoveredDevices(normalizeConfig({ include_stopped: true }));
  assert.deepEqual(
    devices.map((d) => d.name),
    ['backup', 'nginx'],
  );
});

test('hiding stopped containers filters discovery, never what we watch', async () => {
  const { registry } = createRig({
    containers: [
      rawContainer({ Names: ['/nginx'] }),
      rawContainer({ Id: '2', Names: ['/backup'], State: 'exited', Status: 'Exited (0)' }),
    ],
  });
  await registry.list(config);

  const devices = registry.buildDiscoveredDevices(normalizeConfig({ include_stopped: false }));
  assert.deepEqual(
    devices.map((d) => d.name),
    ['nginx'],
  );
  // The stopped container is still tracked: a device already created for it
  // keeps being routable, and startable.
  assert.ok(registry.findByExternalId('ext:docker:container:backup'));
});

test('transport entries report local for every container we can see', async () => {
  const { registry } = createRig({ containers: [rawContainer({ Names: ['/nginx'] })] });
  await registry.list(config);

  const entries = registry.buildTransportEntries();
  assert.deepEqual(entries, [
    { external_id: 'ext:docker:container:nginx', transport: DEVICE_TRANSPORTS.LOCAL },
  ]);
  assert.equal(entries[0].degraded, undefined, 'a nominal entry clears any past degradation');
});

test('a restarting container is reported degraded, with its Docker status', async () => {
  const { registry } = createRig({
    containers: [
      rawContainer({
        Names: ['/flaky'],
        State: 'restarting',
        Status: 'Restarting (1) 2 seconds ago',
      }),
    ],
  });
  await registry.list(config);

  const [entry] = registry.buildTransportEntries();
  assert.equal(entry.transport, DEVICE_TRANSPORTS.LOCAL);
  assert.equal(entry.degraded, true);
  assert.match(entry.message.en, /restarting/);
  assert.ok(entry.message.fr, 'the reason is multi-language');
  assert.ok(entry.message.en.length <= 200, 'tooltip messages are capped at 200 characters');
});

test('when the daemon goes away every known device is reported unreachable', async () => {
  const gladys = createFakeGladys();
  let failing = false;
  const working = createFakeDockerClient({ containers: [rawContainer({ Names: ['/nginx'] })] });
  const broken = createFakeDockerClient({ failWith: new Error('socket hang up') });
  const registry = createRegistry(gladys, { createClient: () => (failing ? broken : working) });

  await registry.list(config);
  failing = true;
  // The client is only rebuilt when the address changes, so force a new one.
  await assert.rejects(() =>
    registry.list(normalizeConfig({ docker_api_url: 'http://elsewhere:2375' }), { force: true }),
  );

  assert.deepEqual(registry.buildTransportEntries(), [
    { external_id: 'ext:docker:container:nginx', transport: DEVICE_TRANSPORTS.UNREACHABLE },
  ]);
});

test('the published payload satisfies the contract the Gladys core enforces', async () => {
  const { registry } = createRig({
    containers: [
      rawContainer({ Names: ['/nginx'] }),
      rawContainer({ Id: '2', Names: ['/backup'], State: 'exited', Status: 'Exited (0)' }),
      rawContainer({
        Id: '3',
        Names: ['/media-plex-1'],
        Labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
      }),
    ],
  });
  await registry.list(config);

  // The core validates the WHOLE list and rejects all of it on the first bad
  // field — one wrong value costs every device. Check both shapes of the
  // payload, with and without the optional stats features.
  assertGladysAcceptsDevices(registry.buildDiscoveredDevices(config));
  assertGladysAcceptsDevices(
    registry.buildDiscoveredDevices(normalizeConfig({ ...config, collect_stats: false })),
  );
});

test('every offered refresh interval produces a payload Gladys accepts', async () => {
  const { registry } = createRig({ containers: [rawContainer()] });
  await registry.list(config);

  for (const frequency of GLADYS_POLL_FREQUENCIES) {
    const devices = registry.buildDiscoveredDevices(
      normalizeConfig({ ...config, poll_frequency: frequency }),
    );
    assertGladysAcceptsDevices(devices);
    assert.equal(devices[0].poll_frequency, frequency);
  }
});
