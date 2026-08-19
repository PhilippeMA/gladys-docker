import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listMatchingContainers, restartChosenContainer, testConnection } from '../src/actions.js';
import { createRegistry } from '../src/registry.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeDockerClient, rawContainer } from './helpers/fakeDocker.js';

const config = normalizeConfig({ docker_api_url: 'http://docker.test:2375' });

/**
 * Build a rig around a fake daemon.
 * @param {object} [options] - Options passed to the fake Docker client.
 * @returns {{ gladys: object, registry: object, client: object }} Test rig.
 */
function createRig(options = {}) {
  const gladys = createFakeGladys();
  const client = createFakeDockerClient(options);
  const registry = createRegistry(gladys, { createClient: () => client });
  return { gladys, registry, client };
}

test('test_connection reports the daemon version and what the filters select', async () => {
  const { registry } = createRig({
    containers: [
      rawContainer({ Names: ['/nginx'] }),
      rawContainer({ Id: '2', Names: ['/backup'], State: 'exited', Status: 'Exited (0)' }),
    ],
  });

  const message = await testConnection(registry, config);
  assert.match(message.en, /Docker 27\.1\.1/);
  assert.match(message.en, /API 1\.46/);
  assert.match(message.en, /2 container\(s\)/);
  assert.match(message.en, /1 running/);
  assert.ok(message.fr, 'the message is multi-language');
});

test('test_connection surfaces the failure instead of swallowing it', async () => {
  const { registry } = createRig({ failWith: new Error('connect ECONNREFUSED 10.0.0.2:2375') });
  await assert.rejects(() => testConnection(registry, config), /ECONNREFUSED/);
});

test('list_containers names the containers and their states', async () => {
  const { registry } = createRig({
    containers: [rawContainer({ Names: ['/nginx'] }), rawContainer({ Id: '2', Names: ['/redis'] })],
  });

  const message = await listMatchingContainers(registry, config);
  assert.match(message.en, /nginx \(running\)/);
  assert.match(message.en, /redis \(running\)/);
});

test('list_containers summarizes a long list instead of flooding the button', async () => {
  const containers = Array.from({ length: 20 }, (_, i) =>
    rawContainer({ Id: `id-${i}`, Names: [`/app-${String(i).padStart(2, '0')}`] }),
  );
  const { registry } = createRig({ containers });

  const message = await listMatchingContainers(registry, config);
  assert.match(message.en, /20 container\(s\)/);
  assert.match(message.en, /and 8 more/);
});

test('list_containers points at the filters when nothing matches', async () => {
  const { registry } = createRig({ containers: [] });
  const message = await listMatchingContainers(registry, config);
  assert.match(message.en, /No container matches your filters/);
});

test('restart_container restarts the chosen device and republishes its state', async () => {
  const { gladys, registry, client } = createRig({ containers: [rawContainer()] });

  const message = await restartChosenContainer(
    gladys,
    registry,
    config,
    'ext:docker:container:nginx',
  );

  assert.ok(client.calls.includes('POST /containers/c0ffee00/restart?t=10'));
  assert.match(message.en, /nginx restarted/);
  assert.equal(gladys.published[0].state, 1);
});

test('restart_container asks for a container rather than failing on an empty field', async () => {
  const { gladys, registry, client } = createRig({ containers: [rawContainer()] });

  const message = await restartChosenContainer(gladys, registry, config, undefined);
  assert.match(message.en, /Pick a container/);
  assert.equal(client.calls.length, 0);
});

test('restart_container explains when the chosen device has no container left', async () => {
  const { gladys, registry } = createRig({ containers: [] });
  await assert.rejects(
    () => restartChosenContainer(gladys, registry, config, 'ext:docker:container:gone'),
    /removed, renamed, or excluded/,
  );
});
