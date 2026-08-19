// -----------------------------------------------------------------------------
// Transport to the Docker Engine API.
//
// Where the "work" happens: every call to the outside world goes through here.
// Node 20+ ships `fetch`, but `fetch` cannot talk to a Unix socket, so this
// client is built on `node:http` / `node:https` — no dependency either way.
//
// Two ways to reach a daemon:
//   - over the network (http:// or https://): the ONLY one available to a
//     published integration. The Gladys sandbox mounts no host path, so the
//     `/var/run/docker.sock` of the host is out of reach by design — the user
//     exposes the API with a socket proxy and gives us its address;
//   - over a Unix socket (unix:// or a plain path): only reachable when you
//     run this image yourself with the socket mounted, i.e. during
//     development. Supported because it makes `npm start` on a laptop work.
//
// Paths are sent unversioned (`/containers/json`, not `/v1.44/containers/json`):
// the daemon then answers with its own API version, which keeps us compatible
// with old and new Docker installations alike.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'docker-client' });

/** Default port of a Docker daemon exposed without TLS. */
const DEFAULT_HTTP_PORT = 2375;
/** Default port of a Docker daemon exposed with TLS. */
const DEFAULT_HTTPS_PORT = 2376;

/**
 * An error raised by the Docker API layer. Carries the HTTP status when the
 * daemon answered, so callers can tell "already started" (304) from a real
 * failure without parsing messages.
 */
export class DockerApiError extends Error {
  /**
   * @param {string} message - Human-readable reason.
   * @param {object} [options] - Extra context.
   * @param {number} [options.status] - HTTP status returned by the daemon.
   * @param {string} [options.path] - API path that was requested.
   */
  constructor(message, { status, path } = {}) {
    super(message);
    this.name = 'DockerApiError';
    this.status = status;
    this.path = path;
  }
}

/**
 * Parse the address the user typed into a connection target. Accepts the
 * shapes people actually paste: a full URL, a `tcp://` URL (what the Docker
 * CLI uses), a bare `host:port`, or a Unix socket path.
 * @param {string} rawUrl - Address from the configuration.
 * @returns {{ protocol: string, socketPath?: string, host?: string, port?: number }} Connection target.
 */
export function parseDockerApiUrl(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (value.length === 0) {
    throw new DockerApiError('No Docker API address configured');
  }

  // A Unix socket, either explicit (unix:///var/run/docker.sock) or a plain
  // absolute path — the shape people copy from a docker-compose file.
  if (value.startsWith('unix://')) {
    return { protocol: 'unix:', socketPath: value.slice('unix://'.length) };
  }
  if (value.startsWith('/')) {
    return { protocol: 'unix:', socketPath: value };
  }

  // `tcp://` is what DOCKER_HOST uses; it is plain HTTP on the wire.
  const normalized = value.startsWith('tcp://')
    ? `http://${value.slice('tcp://'.length)}`
    : /^https?:\/\//.test(value)
      ? value
      : `http://${value}`;

  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new DockerApiError(`Invalid Docker API address: ${value}`);
  }
  if (url.hostname.length === 0) {
    throw new DockerApiError(`Invalid Docker API address: ${value}`);
  }

  return {
    protocol: url.protocol,
    host: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT),
  };
}

/**
 * Human-readable description of a target, for logs and error messages.
 * @param {object} target - Target returned by parseDockerApiUrl.
 * @returns {string} Description.
 */
export function describeTarget(target) {
  return target.protocol === 'unix:'
    ? `unix://${target.socketPath}`
    : `${target.protocol}//${target.host}:${target.port}`;
}

/**
 * Build a client bound to one Docker daemon. Rebuild it when the user changes
 * the address (see index.js): a client holds no connection, it is cheap.
 * @param {object} config - Normalized integration configuration.
 * @returns {{ target: object, request: Function }} Docker client.
 */
export function createDockerClient(config) {
  const target = parseDockerApiUrl(config.docker_api_url);
  const insecure = target.protocol === 'https:' && config.tls_insecure === true;

  /**
   * Perform one request against the Docker API.
   * @param {object} options - Request options.
   * @param {string} options.path - API path, e.g. '/containers/json?all=true'.
   * @param {string} [options.method] - HTTP method, GET by default.
   * @param {number} [options.timeout] - Timeout in milliseconds.
   * @returns {Promise<unknown>} Parsed JSON body, or null for an empty body.
   */
  async function request({ path, method = 'GET', timeout = 15_000 }) {
    const transport = target.protocol === 'https:' ? https : http;
    const options = {
      method,
      path,
      timeout,
      headers: { Accept: 'application/json' },
      ...(target.protocol === 'unix:'
        ? { socketPath: target.socketPath }
        : { host: target.host, port: target.port }),
      ...(insecure ? { rejectUnauthorized: false } : {}),
    };

    logger.debug(`${method} ${describeTarget(target)}${path}`);

    const { status, body } = await new Promise((resolve, reject) => {
      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      });
      req.on('timeout', () => {
        req.destroy(new DockerApiError(`Docker API timed out after ${timeout} ms`, { path }));
      });
      req.on('error', (err) =>
        reject(
          err instanceof DockerApiError
            ? err
            : new DockerApiError(
                `Cannot reach the Docker API at ${describeTarget(target)}: ${err.message}`,
                { path },
              ),
        ),
      );
      req.end();
    });

    if (status >= 400) {
      // The daemon answers errors as { message: '...' }; fall back to the raw
      // body when it does not (a reverse proxy answering HTML, typically).
      let reason = body.slice(0, 200);
      try {
        reason = JSON.parse(body).message ?? reason;
      } catch {
        // Not JSON: keep the truncated raw body.
      }
      throw new DockerApiError(`Docker API ${status} on ${path}: ${reason}`, { status, path });
    }

    if (body.length === 0) {
      return null;
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new DockerApiError(
        `Docker API returned a non-JSON body on ${path} — is this address really a Docker API?`,
        { status, path },
      );
    }
  }

  return { target, request };
}
