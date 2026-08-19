// -----------------------------------------------------------------------------
// The rules the Gladys core applies to a discovery payload, mirrored here.
//
// Why this exists: the core validates the WHOLE list and rejects all of it on
// the first bad field, so one wrong value on one device costs every device of
// the integration — and the failure only shows up against a real server. These
// assertions run that contract offline, on the payload we would actually send.
//
// Mirrored from externalIntegration.setDiscoveredDevices in the Gladys core.
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { GLADYS_POLL_FREQUENCIES } from '../../src/config.js';

/** Max devices the core accepts in one discovery payload. */
const MAX_DISCOVERED_DEVICES = 2000;

const CATEGORIES = new Set(Object.values(DEVICE_FEATURE_CATEGORIES));
const TYPES = new Set(Object.values(DEVICE_FEATURE_TYPES).flatMap((group) => Object.values(group)));
const UNITS = new Set(Object.values(DEVICE_FEATURE_UNITS));

/**
 * Assert that Gladys would accept every device of a discovery payload.
 * @param {object[]} devices - Payload passed to publishDiscoveredDevices.
 * @param {string} [externalIdPrefix] - Prefix the core enforces on external ids.
 */
export function assertGladysAcceptsDevices(devices, externalIdPrefix = 'ext:docker:') {
  assert.ok(Array.isArray(devices), 'devices must be an array');
  assert.ok(devices.length <= MAX_DISCOVERED_DEVICES, `at most ${MAX_DISCOVERED_DEVICES} devices`);

  devices.forEach((device, index) => {
    const where = `devices[${index}]`;
    assert.equal(typeof device.name, 'string', `${where}.name must be a string`);
    assert.ok(device.name.length > 0, `${where}.name must not be empty`);
    assert.ok(
      typeof device.external_id === 'string' && device.external_id.startsWith(externalIdPrefix),
      `${where}.external_id must start with "${externalIdPrefix}"`,
    );
    if (device.poll_frequency !== undefined) {
      assert.ok(
        GLADYS_POLL_FREQUENCIES.includes(device.poll_frequency),
        `${where}.poll_frequency: ${device.poll_frequency} is not a frequency Gladys accepts`,
      );
    }
    assert.ok(Array.isArray(device.features), `${where}.features must be an array`);

    device.features.forEach((feature, featureIndex) => {
      const featureWhere = `${where}.features[${featureIndex}]`;
      assert.ok(
        typeof feature.external_id === 'string' && feature.external_id.startsWith(externalIdPrefix),
        `${featureWhere}.external_id must start with "${externalIdPrefix}"`,
      );
      assert.ok(CATEGORIES.has(feature.category), `${featureWhere}.category: unknown category`);
      assert.ok(TYPES.has(feature.type), `${featureWhere}.type: unknown type`);
      if (feature.unit !== undefined && feature.unit !== null) {
        assert.ok(UNITS.has(feature.unit), `${featureWhere}.unit: unknown unit`);
      }
    });

    for (const param of device.params ?? []) {
      assert.equal(typeof param.name, 'string', `${where}.params: a param needs a name`);
      assert.equal(
        typeof param.value,
        'string',
        `${where}.params.${param.name}: value is a string`,
      );
      assert.ok(
        !param.name.toUpperCase().startsWith('GLADYS_'),
        `${where}.params.${param.name}: the GLADYS_ prefix is reserved to the core`,
      );
    }
  });
}
