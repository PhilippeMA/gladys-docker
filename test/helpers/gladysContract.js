// -----------------------------------------------------------------------------
// The rules the Gladys core applies to what we publish, mirrored here.
//
// There are TWO gates, and passing the first says nothing about the second:
//
//   1. publishDiscoveredDevices -> externalIntegration.setDiscoveredDevices.
//      Checks the external id prefix, the poll frequency, the categories,
//      types and units. Validates the WHOLE list and rejects all of it on the
//      first bad field: one wrong value costs every device.
//   2. the user adds the device from the Discovery tab -> POST /device ->
//      device.create -> the Sequelize models. This is where the NOT NULL
//      columns are enforced. A payload can sail through gate 1 and be refused
//      here, days later, when someone finally clicks "add" — which is the
//      worst possible moment to discover it.
//
// Both are mirrored below so the payload is checked offline, in full, against
// what a real server would say. Sources in the Gladys core:
// lib/external-integration/externalIntegration.setDiscoveredDevices.js,
// models/device.js, models/device_feature.js, models/device_param.js.
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

/**
 * Columns of t_device_feature declared NOT NULL without a default value. The
 * integration supplies every one of them or the device cannot be created —
 * `min` and `max` included, on a binary switch and a text feature just as much
 * as on a numeric sensor.
 */
const REQUIRED_FEATURE_COLUMNS = [
  'name',
  'external_id',
  'category',
  'type',
  'read_only',
  'has_feedback',
  'min',
  'max',
];

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

      // Gate 2: the NOT NULL columns of t_device_feature. Discovery accepts a
      // feature without these; POST /device does not, so the failure lands on
      // the user at "add device" time rather than on us at publish time.
      for (const column of REQUIRED_FEATURE_COLUMNS) {
        assert.notEqual(
          feature[column],
          undefined,
          `${featureWhere}.${column}: NOT NULL in t_device_feature, Gladys refuses to create the device without it`,
        );
        assert.notEqual(feature[column], null, `${featureWhere}.${column}: must not be null`);
      }
      for (const column of ['min', 'max']) {
        assert.equal(
          typeof feature[column],
          'number',
          `${featureWhere}.${column}: t_device_feature.${column} is a DOUBLE`,
        );
        assert.ok(Number.isFinite(feature[column]), `${featureWhere}.${column}: must be finite`);
      }
      assert.ok(
        feature.min <= feature.max,
        `${featureWhere}: min (${feature.min}) must not exceed max (${feature.max})`,
      );
      if (feature.step !== undefined && feature.step !== null) {
        assert.ok(feature.step > 0, `${featureWhere}.step: must be greater than 0`);
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
