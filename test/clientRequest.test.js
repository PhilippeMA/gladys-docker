// -----------------------------------------------------------------------------
// The transport layer, exercised against a real HTTP server on the loopback.
//
// Everything else in this suite talks to a faked daemon, which is the right
// level for logic — but it never runs the one file that actually opens a
// socket. These tests do: status handling, error shaping, and the 304 Docker
// answers when the requested state is already the current one.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createDockerClient, DockerApiError } from '../src/docker/client.js';

/**
 * Start a throwaway HTTP server and a client pointing at it.
 * @param {Function} handler - Node request handler.
 * @returns {Promise<{ client: object, close: Function, requests: object[] }>} Test rig.
 */
async function withServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    requests,
    client: createDockerClient({ docker_api_url: `http://127.0.0.1:${port}`, tls_insecure: false }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('a JSON answer is parsed and the method and path are sent as asked', async () => {
  const { client, close, requests } = await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Version: '27.1.1' }));
  });
  try {
    assert.deepEqual(await client.request({ path: '/version' }), { Version: '27.1.1' });
    assert.deepEqual(requests, [{ method: 'GET', url: '/version' }]);

    await client.request({ method: 'POST', path: '/containers/abc/stop?t=10' });
    assert.deepEqual(requests[1], { method: 'POST', url: '/containers/abc/stop?t=10' });
  } finally {
    await close();
  }
});

test('an empty body resolves to null rather than failing to parse', async () => {
  const { client, close } = await withServer((req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    assert.equal(await client.request({ method: 'POST', path: '/containers/abc/start' }), null);
  } finally {
    await close();
  }
});

test('a 304 is a success: Docker answers it when the state is already the one asked for', async () => {
  const { client, close } = await withServer((req, res) => {
    res.writeHead(304);
    res.end();
  });
  try {
    // Starting an already-running container must not look like a failure.
    assert.equal(await client.request({ method: 'POST', path: '/containers/abc/start' }), null);
  } finally {
    await close();
  }
});

test('the message the daemon puts in its error body is the one surfaced', async () => {
  const { client, close } = await withServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'No such container: ghost' }));
  });
  try {
    await assert.rejects(
      () => client.request({ path: '/containers/ghost/json' }),
      (err) => {
        assert.ok(err instanceof DockerApiError);
        assert.equal(err.status, 404);
        assert.match(err.message, /No such container: ghost/);
        return true;
      },
    );
  } finally {
    await close();
  }
});

test('a proxy refusing the call keeps its status, so 403 stays recognizable', async () => {
  const { client, close } = await withServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
  });
  try {
    await assert.rejects(
      () => client.request({ path: '/containers/json' }),
      (err) => {
        assert.equal(err.status, 403);
        assert.match(err.message, /Forbidden/);
        return true;
      },
    );
  } finally {
    await close();
  }
});

test('something that is not a Docker API says so, instead of a parse error', async () => {
  const { client, close } = await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>router login</html>');
  });
  try {
    await assert.rejects(
      () => client.request({ path: '/version' }),
      /is this address really a Docker API/,
    );
  } finally {
    await close();
  }
});

test('a server that never answers gives up on the timeout, naming it', async () => {
  const { client, close } = await withServer(() => {
    // Answer nothing at all.
  });
  try {
    await assert.rejects(
      () => client.request({ path: '/version', timeout: 150 }),
      /timed out after 150 ms/,
    );
  } finally {
    await close();
  }
});

test('an unreachable address names the target it could not reach', async () => {
  // Port 1 on the loopback: nothing listens there, the connection is refused.
  const client = createDockerClient({ docker_api_url: 'http://127.0.0.1:1', tls_insecure: false });
  await assert.rejects(
    () => client.request({ path: '/version' }),
    (err) => {
      assert.ok(err instanceof DockerApiError);
      assert.match(err.message, /Cannot reach the Docker API at http:\/\/127\.0\.0\.1:1/);
      return true;
    },
  );
});
