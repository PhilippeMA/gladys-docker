import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDegraded,
  isRunning,
  matchesFilters,
  normalizeContainer,
  selectContainers,
} from '../src/docker/containers.js';
import { normalizeConfig } from '../src/config.js';
import { rawContainer } from './helpers/fakeDocker.js';

test('normalizeContainer strips the leading slash Docker puts on names', () => {
  assert.equal(normalizeContainer(rawContainer({ Names: ['/media-plex'] })).name, 'media-plex');
});

test('normalizeContainer reads the compose project and service labels', () => {
  const container = normalizeContainer(
    rawContainer({
      Labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
    }),
  );
  assert.equal(container.composeProject, 'media');
  assert.equal(container.composeService, 'plex');
});

test('normalizeContainer reads the health reported inside the status string', () => {
  assert.equal(
    normalizeContainer(rawContainer({ Status: 'Up 2 hours (healthy)' })).health,
    'healthy',
  );
  assert.equal(
    normalizeContainer(rawContainer({ Status: 'Up 3 minutes (unhealthy)' })).health,
    'unhealthy',
  );
  assert.equal(
    normalizeContainer(rawContainer({ Status: 'Up 4 seconds (health: starting)' })).health,
    'starting',
  );
  assert.equal(normalizeContainer(rawContainer({ Status: 'Up 2 hours' })).health, null);
});

test('isRunning follows the Docker state', () => {
  assert.equal(isRunning(normalizeContainer(rawContainer({ State: 'running' }))), true);
  assert.equal(isRunning(normalizeContainer(rawContainer({ State: 'exited' }))), false);
});

test('isDegraded flags the states that deserve a second look', () => {
  const degraded = (overrides) => isDegraded(normalizeContainer(rawContainer(overrides)));
  assert.equal(degraded({ State: 'running' }), false);
  assert.equal(degraded({ State: 'exited' }), false, 'a stopped container is off, not degraded');
  assert.equal(degraded({ State: 'restarting' }), true);
  assert.equal(degraded({ State: 'paused' }), true);
  assert.equal(degraded({ State: 'dead' }), true);
  assert.equal(degraded({ State: 'running', Status: 'Up 3 minutes (unhealthy)' }), true);
});

test('an empty inclusion filter selects every container', () => {
  assert.equal(matchesFilters('anything', normalizeConfig({ exclude_filter: '' })), true);
});

test('the inclusion filter understands * and is case-insensitive', () => {
  const config = normalizeConfig({ name_filter: 'media-*, NGINX', exclude_filter: '' });
  assert.equal(matchesFilters('media-plex', config), true);
  assert.equal(matchesFilters('nginx', config), true);
  assert.equal(matchesFilters('postgres', config), false);
});

test('the exclusion filter is applied last and always wins', () => {
  const config = normalizeConfig({ name_filter: 'media-*', exclude_filter: 'media-db' });
  assert.equal(matchesFilters('media-plex', config), true);
  assert.equal(matchesFilters('media-db', config), false);
});

test('a filter pattern never behaves like a regular expression', () => {
  const config = normalizeConfig({ name_filter: 'my.app', exclude_filter: '' });
  assert.equal(matchesFilters('my.app', config), true);
  assert.equal(matchesFilters('myXapp', config), false, 'the dot must stay literal');
});

test('empty entries in a filter are ignored rather than matching nothing', () => {
  const config = normalizeConfig({ name_filter: 'nginx, ,', exclude_filter: '' });
  assert.equal(matchesFilters('nginx', config), true);
  assert.equal(matchesFilters('postgres', config), false);
});

test('Gladys containers are excluded out of the box', () => {
  const config = normalizeConfig();
  assert.equal(matchesFilters('gladys', config), false);
  assert.equal(matchesFilters('gladys-assistant', config), false);
  assert.equal(matchesFilters('nginx', config), true);
});

test('selectContainers normalizes, filters and sorts by name', () => {
  const selected = selectContainers(
    [
      rawContainer({ Id: '1', Names: ['/zeta'] }),
      rawContainer({ Id: '2', Names: ['/alpha'] }),
      rawContainer({ Id: '3', Names: ['/gladys-server'] }),
    ],
    normalizeConfig(),
  );
  assert.deepEqual(
    selected.map((container) => container.name),
    ['alpha', 'zeta'],
  );
});
