// -----------------------------------------------------------------------------
// A fake Docker daemon: a client with the same `request()` surface as the real
// one, answering from a scripted container list. It records every path it was
// asked for, which is how the tests check that a start really sent a start.
// -----------------------------------------------------------------------------

/**
 * Build a raw container summary, in the shape `GET /containers/json` returns.
 * @param {object} overrides - Fields to override.
 * @returns {object} Raw container summary.
 */
export function rawContainer(overrides = {}) {
  return {
    Id: 'c0ffee00',
    Names: ['/nginx'],
    Image: 'nginx:1.27',
    State: 'running',
    Status: 'Up 2 hours',
    Labels: {},
    ...overrides,
  };
}

/**
 * Build a fake Docker client.
 * @param {object} [options] - Options.
 * @param {object[]} [options.containers] - Raw containers the daemon returns.
 * @param {object} [options.stats] - Stats sample returned for any container.
 * @param {object} [options.version] - Version payload.
 * @param {Error} [options.failWith] - When set, every request rejects with it.
 * @returns {object} Fake Docker client with a `calls` array.
 */
export function createFakeDockerClient({ containers = [], stats = null, version, failWith } = {}) {
  const calls = [];
  return {
    calls,
    target: { protocol: 'http:', host: 'docker.test', port: 2375 },
    async request({ path, method = 'GET' }) {
      calls.push(`${method} ${path}`);
      if (failWith) {
        throw failWith;
      }
      if (path === '/version') {
        return version ?? { Version: '27.1.1', ApiVersion: '1.46', Os: 'linux', Arch: 'arm64' };
      }
      if (path.startsWith('/containers/json')) {
        return containers;
      }
      if (path.includes('/stats')) {
        return stats;
      }
      return null;
    },
  };
}
