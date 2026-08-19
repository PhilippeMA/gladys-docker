import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DockerApiError, describeTarget, parseDockerApiUrl } from '../src/docker/client.js';

test('parseDockerApiUrl accepts a plain http address', () => {
  assert.deepEqual(parseDockerApiUrl('http://192.168.1.10:2375'), {
    protocol: 'http:',
    host: '192.168.1.10',
    port: 2375,
  });
});

test('parseDockerApiUrl accepts the tcp:// form used by DOCKER_HOST', () => {
  assert.deepEqual(parseDockerApiUrl('tcp://docker.lan:2375'), {
    protocol: 'http:',
    host: 'docker.lan',
    port: 2375,
  });
});

test('parseDockerApiUrl accepts a bare host:port', () => {
  assert.deepEqual(parseDockerApiUrl('docker.lan:2375'), {
    protocol: 'http:',
    host: 'docker.lan',
    port: 2375,
  });
});

test('parseDockerApiUrl defaults the port to 2375 without TLS and 2376 with it', () => {
  assert.equal(parseDockerApiUrl('http://docker.lan').port, 2375);
  assert.equal(parseDockerApiUrl('https://docker.lan').port, 2376);
});

test('parseDockerApiUrl accepts a Unix socket, with or without the scheme', () => {
  assert.deepEqual(parseDockerApiUrl('unix:///var/run/docker.sock'), {
    protocol: 'unix:',
    socketPath: '/var/run/docker.sock',
  });
  assert.deepEqual(parseDockerApiUrl('/var/run/docker.sock'), {
    protocol: 'unix:',
    socketPath: '/var/run/docker.sock',
  });
});

test('parseDockerApiUrl rejects an empty or unusable address', () => {
  assert.throws(() => parseDockerApiUrl(''), DockerApiError);
  assert.throws(() => parseDockerApiUrl('   '), DockerApiError);
  assert.throws(() => parseDockerApiUrl('http://'), DockerApiError);
});

test('describeTarget renders both kinds of target', () => {
  assert.equal(
    describeTarget(parseDockerApiUrl('tcp://docker.lan:2375')),
    'http://docker.lan:2375',
  );
  assert.equal(
    describeTarget(parseDockerApiUrl('/var/run/docker.sock')),
    'unix:///var/run/docker.sock',
  );
});
