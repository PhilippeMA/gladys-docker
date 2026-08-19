import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({
    docker_api_url: 'http://10.0.0.2:2375',
    name_filter: 'media-*',
  });
  assert.equal(config.docker_api_url, 'http://10.0.0.2:2375');
  assert.equal(config.name_filter, 'media-*');
});

test('normalizeConfig trims the Docker API address', () => {
  assert.equal(
    normalizeConfig({ docker_api_url: '  http://a:2375 ' }).docker_api_url,
    'http://a:2375',
  );
});

test('normalizeConfig coerces numeric strings coming from a form', () => {
  const config = normalizeConfig({ poll_frequency: '120', stop_timeout: '5' });
  assert.equal(config.poll_frequency, 120);
  assert.equal(typeof config.poll_frequency, 'number');
  assert.equal(config.stop_timeout, 5);
});

test('normalizeConfig clamps numbers into the range the manifest declares', () => {
  assert.equal(normalizeConfig({ poll_frequency: 1 }).poll_frequency, 30);
  assert.equal(normalizeConfig({ poll_frequency: 99999 }).poll_frequency, 3600);
  assert.equal(normalizeConfig({ discovery_frequency: 5 }).discovery_frequency, 60);
  assert.equal(normalizeConfig({ stop_timeout: -4 }).stop_timeout, 0);
});

test('normalizeConfig falls back to the default for an unreadable number', () => {
  assert.equal(
    normalizeConfig({ poll_frequency: 'soon' }).poll_frequency,
    DEFAULT_CONFIG.poll_frequency,
  );
});

test('normalizeConfig reads booleans, including the strings a form may send', () => {
  assert.equal(normalizeConfig({ collect_stats: false }).collect_stats, false);
  assert.equal(normalizeConfig({ collect_stats: 'false' }).collect_stats, false);
  assert.equal(normalizeConfig({ collect_stats: 'true' }).collect_stats, true);
  assert.equal(normalizeConfig({ tls_insecure: true }).tls_insecure, true);
  assert.equal(normalizeConfig({}).collect_stats, DEFAULT_CONFIG.collect_stats);
});

test('isConfigured only accepts a non-empty Docker API address', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ docker_api_url: '   ' })), false);
  assert.equal(isConfigured(normalizeConfig({ docker_api_url: 'http://a:2375' })), true);
});
