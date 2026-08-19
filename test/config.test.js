import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  GLADYS_POLL_FREQUENCIES,
  isConfigured,
  normalizeConfig,
} from '../src/config.js';

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
  const config = normalizeConfig({ discovery_frequency: '900', stop_timeout: '5' });
  assert.equal(config.discovery_frequency, 900);
  assert.equal(typeof config.discovery_frequency, 'number');
  assert.equal(config.stop_timeout, 5);
});

test('normalizeConfig clamps numbers into the range the manifest declares', () => {
  assert.equal(normalizeConfig({ discovery_frequency: 5 }).discovery_frequency, 60);
  assert.equal(normalizeConfig({ discovery_frequency: 99999 }).discovery_frequency, 3600);
  assert.equal(normalizeConfig({ stop_timeout: -4 }).stop_timeout, 0);
});

test('normalizeConfig falls back to the default for an unreadable number', () => {
  assert.equal(
    normalizeConfig({ discovery_frequency: 'soon' }).discovery_frequency,
    DEFAULT_CONFIG.discovery_frequency,
  );
});

test('the poll frequency is a millisecond value Gladys accepts, not seconds', () => {
  // Gladys refuses the whole discovery payload over one bad frequency, and a
  // value in seconds is exactly what looks right and is refused.
  assert.ok(GLADYS_POLL_FREQUENCIES.includes(DEFAULT_CONFIG.poll_frequency));
  assert.equal(DEFAULT_CONFIG.poll_frequency, 60_000);
});

test('normalizeConfig accepts every frequency of the closed list, as a string too', () => {
  for (const frequency of GLADYS_POLL_FREQUENCIES) {
    assert.equal(normalizeConfig({ poll_frequency: frequency }).poll_frequency, frequency);
    assert.equal(normalizeConfig({ poll_frequency: String(frequency) }).poll_frequency, frequency);
  }
});

test('a frequency Gladys would refuse falls back to the default', () => {
  // 60 is the seconds-shaped value that caused a rejection of every device.
  for (const refused of [60, 300, 45_000, 0, -1, 'often', null]) {
    assert.equal(
      normalizeConfig({ poll_frequency: refused }).poll_frequency,
      DEFAULT_CONFIG.poll_frequency,
      `${refused} must not reach Gladys`,
    );
  }
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
