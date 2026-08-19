// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface this integration relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates   -> recorded so tests can assert them
//   - publishDiscoveredDevices       -> recorded so tests can assert them
//   - publishTransports              -> recorded so tests can assert them
//   - setConnectionStatus            -> recorded so tests can assert them
// This lets us test the wiring (discovery payloads, dispatch, commands) without
// a running Gladys server or a WebSocket.
// -----------------------------------------------------------------------------

/**
 * Build a fake SDK instance.
 * @returns {object} Fake Gladys instance with recorded calls.
 */
export function createFakeGladys() {
  const published = [];
  const discovered = [];
  const transports = [];
  const connectionStatuses = [];

  return {
    published,
    discovered,
    transports,
    connectionStatuses,

    externalIds(type, platformId) {
      const device = `ext:docker:${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const state of states) {
        published.push({
          featureExternalId: state.device_feature_external_id,
          state: state.state,
          text: state.text,
        });
      }
    },

    async publishDiscoveredDevices(devices) {
      discovered.push(devices);
      return { success: true, count: devices.length };
    },

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}
