// -----------------------------------------------------------------------------
// The handful of Docker Engine API endpoints this integration needs.
//
// Everything is expressed on top of `client.request()`, so the whole surface
// we depend on — and therefore the permissions a socket proxy has to grant —
// is visible in this one file:
//
//   GET  /version                          daemon version (connection test)
//   GET  /containers/json?all=true         the container list
//   GET  /containers/{id}/stats            one CPU / memory sample
//   POST /containers/{id}/start            start
//   POST /containers/{id}/stop             stop
//   POST /containers/{id}/restart          restart
//
// A read-only proxy (CONTAINERS=1 only) is enough for monitoring; starting,
// stopping and restarting additionally need POST to be allowed.
// -----------------------------------------------------------------------------

/**
 * Read the daemon version — the cheapest call that proves we talk to Docker.
 * @param {object} client - Docker client.
 * @returns {Promise<object>} Version payload.
 */
export async function getVersion(client) {
  return client.request({ path: '/version', timeout: 10_000 });
}

/**
 * List the containers of the daemon.
 *
 * Always called with `all=true`, even when the user hides stopped containers:
 * a container the user already added as a device must keep being tracked once
 * it stops, otherwise its device would freeze and could never be started again.
 * `include_stopped` filters what discovery OFFERS, not what we watch.
 * @param {object} client - Docker client.
 * @returns {Promise<object[]>} Raw container summaries.
 */
export async function listContainers(client) {
  const containers = await client.request({ path: '/containers/json?all=true', timeout: 15_000 });
  return Array.isArray(containers) ? containers : [];
}

/**
 * Read one CPU / memory sample of a container.
 *
 * `stream=false` makes the daemon answer a single JSON document instead of an
 * endless stream. It takes about a second: the daemon needs two readings to
 * compute a CPU delta, and it returns the previous one in `precpu_stats`.
 * (`one-shot=true` would answer instantly but with an empty `precpu_stats`,
 * making the CPU percentage impossible to compute — so we do not use it.)
 * @param {object} client - Docker client.
 * @param {string} id - Container id or name.
 * @returns {Promise<object>} Raw stats sample.
 */
export async function getContainerStats(client, id) {
  return client.request({
    path: `/containers/${encodeURIComponent(id)}/stats?stream=false`,
    timeout: 30_000,
  });
}

/**
 * Start a container. A container that is already running answers 304, which
 * the client lets through: the requested state is the reached state.
 * @param {object} client - Docker client.
 * @param {string} id - Container id or name.
 * @returns {Promise<void>} Resolves once the daemon acknowledged.
 */
export async function startContainer(client, id) {
  await client.request({
    method: 'POST',
    path: `/containers/${encodeURIComponent(id)}/start`,
    timeout: 60_000,
  });
}

/**
 * Stop a container, giving it `timeoutSeconds` to exit before Docker kills it.
 * The HTTP timeout is the grace period plus a margin, so we never give up
 * before Docker does.
 * @param {object} client - Docker client.
 * @param {string} id - Container id or name.
 * @param {number} timeoutSeconds - Grace period passed to Docker.
 * @returns {Promise<void>} Resolves once the daemon acknowledged.
 */
export async function stopContainer(client, id, timeoutSeconds) {
  await client.request({
    method: 'POST',
    path: `/containers/${encodeURIComponent(id)}/stop?t=${Math.round(timeoutSeconds)}`,
    timeout: (Math.round(timeoutSeconds) + 30) * 1000,
  });
}

/**
 * Restart a container, with the same grace period as a stop.
 * @param {object} client - Docker client.
 * @param {string} id - Container id or name.
 * @param {number} timeoutSeconds - Grace period passed to Docker.
 * @returns {Promise<void>} Resolves once the daemon acknowledged.
 */
export async function restartContainer(client, id, timeoutSeconds) {
  await client.request({
    method: 'POST',
    path: `/containers/${encodeURIComponent(id)}/restart?t=${Math.round(timeoutSeconds)}`,
    timeout: (Math.round(timeoutSeconds) + 60) * 1000,
  });
}
