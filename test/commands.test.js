import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollContainerDevice, setContainerValue } from '../src/commands.js';
import { createRegistry } from '../src/registry.js';
import { normalizeConfig } from '../src/config.js';
import { FEATURE } from '../src/devices/container.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeDockerClient, rawContainer } from './helpers/fakeDocker.js';

const MB = 1024 * 1024;

const STATS = {
  cpu_stats: {
    cpu_usage: { total_usage: 2_000_000 },
    system_cpu_usage: 100_000_000,
    online_cpus: 2,
  },
  precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 90_000_000 },
  memory_stats: { usage: 100 * MB, stats: { inactive_file: 0 } },
};

const config = normalizeConfig({ docker_api_url: 'http://docker.test:2375' });

/**
 * Build a rig around a fake daemon holding one nginx container.
 * @param {object} [options] - Options passed to the fake Docker client.
 * @returns {{ gladys: object, registry: object, client: object, device: object }} Test rig.
 */
function createRig(options = {}) {
  const gladys = createFakeGladys();
  const client = createFakeDockerClient({ containers: [rawContainer()], ...options });
  const registry = createRegistry(gladys, { createClient: () => client });
  return { gladys, registry, client, device: { external_id: 'ext:docker:container:nginx' } };
}

test('polling publishes the state and the stats of a running container', async () => {
  const { gladys, registry, device } = createRig({ stats: STATS });

  await pollContainerDevice(gladys, registry, config, device);

  const byFeature = Object.fromEntries(
    gladys.published.map((p) => [p.featureExternalId, p.state ?? p.text]),
  );
  assert.equal(byFeature[`${device.external_id}:${FEATURE.ON_OFF}`], 1);
  assert.equal(byFeature[`${device.external_id}:${FEATURE.STATE}`], 'running');
  assert.equal(byFeature[`${device.external_id}:${FEATURE.CPU}`], 20);
  assert.equal(byFeature[`${device.external_id}:${FEATURE.MEMORY}`], 100);
});

test('polling skips the stats call when the user turned them off', async () => {
  const { gladys, registry, client, device } = createRig({ stats: STATS });

  await pollContainerDevice(
    gladys,
    registry,
    normalizeConfig({ ...config, collect_stats: false }),
    device,
  );

  assert.ok(!client.calls.some((call) => call.includes('/stats')));
  assert.equal(gladys.published.length, 2);
});

test('polling never asks a stopped container for stats', async () => {
  const { gladys, registry, client, device } = createRig({
    containers: [rawContainer({ State: 'exited', Status: 'Exited (0) 1 hour ago' })],
    stats: STATS,
  });

  await pollContainerDevice(gladys, registry, config, device);

  assert.ok(!client.calls.some((call) => call.includes('/stats')));
  assert.equal(gladys.published[0].state, 0);
  assert.equal(gladys.published[1].text, 'exited');
});

test('a stats failure costs the readings, not the state we already know', async () => {
  const gladys = createFakeGladys();
  const client = {
    calls: [],
    target: {},
    async request({ path }) {
      client.calls.push(path);
      if (path.includes('/stats')) {
        throw new Error('stats unavailable');
      }
      return [rawContainer()];
    },
  };
  const registry = createRegistry(gladys, { createClient: () => client });

  await pollContainerDevice(gladys, registry, config, {
    external_id: 'ext:docker:container:nginx',
  });

  assert.equal(gladys.published.length, 2, 'the state was still published');
  assert.equal(gladys.published[0].state, 1);
});

test('polling a device whose container vanished says so explicitly', async () => {
  const { gladys, registry } = createRig({ containers: [] });

  await assert.rejects(
    () =>
      pollContainerDevice(gladys, registry, config, { external_id: 'ext:docker:container:gone' }),
    /removed, renamed, or excluded/,
  );
});

test('turning a container on sends a start and publishes the confirmed state', async () => {
  const { gladys, registry, client, device } = createRig({
    containers: [rawContainer({ State: 'exited', Status: 'Exited (0)' })],
  });

  await setContainerValue(gladys, registry, config, {
    device,
    feature: { external_id: `${device.external_id}:${FEATURE.ON_OFF}` },
    value: 1,
  });

  assert.ok(client.calls.includes('POST /containers/c0ffee00/start'));
  // The daemon still reports the container as exited: the feature has feedback,
  // so what is published is what the daemon says, not what was asked for.
  assert.equal(gladys.published[0].state, 0);
  assert.equal(gladys.published[1].text, 'exited');
});

test('turning a container off sends a stop carrying the configured grace period', async () => {
  const { gladys, registry, client, device } = createRig();

  await setContainerValue(gladys, registry, normalizeConfig({ ...config, stop_timeout: 25 }), {
    device,
    feature: { external_id: `${device.external_id}:${FEATURE.ON_OFF}` },
    value: 0,
  });

  assert.ok(client.calls.includes('POST /containers/c0ffee00/stop?t=25'));
});

test('a command re-reads the daemon instead of trusting its cached list', async () => {
  const { gladys, registry, client, device } = createRig();

  await setContainerValue(gladys, registry, config, {
    device,
    feature: { external_id: `${device.external_id}:${FEATURE.ON_OFF}` },
    value: 1,
  });

  const listCalls = client.calls.filter((call) => call.includes('/containers/json'));
  assert.equal(listCalls.length, 2, 'one list to resolve the container, one to confirm the result');
});

test('a read-only feature refuses to be commanded', async () => {
  const { gladys, registry, device } = createRig();

  await assert.rejects(
    () =>
      setContainerValue(gladys, registry, config, {
        device,
        feature: { external_id: `${device.external_id}:${FEATURE.CPU}` },
        value: 1,
      }),
    /read-only/,
  );
});
