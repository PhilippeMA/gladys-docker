import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCpuPercent, computeMemoryMb, summarizeStats } from '../src/docker/stats.js';

const MB = 1024 * 1024;

/**
 * Build a stats sample in the shape the Docker API returns.
 * @param {object} overrides - Fields to override.
 * @returns {object} Stats sample.
 */
function sample(overrides = {}) {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000 },
      system_cpu_usage: 100_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000_000 },
      system_cpu_usage: 90_000_000,
    },
    memory_stats: { usage: 200 * MB, limit: 1024 * MB, stats: { inactive_file: 50 * MB } },
    ...overrides,
  };
}

test('computeCpuPercent uses the delta over the system delta, times the cores', () => {
  // 1e6 / 1e7 = 10% of the system time, spread over 4 cores -> 40%.
  assert.equal(computeCpuPercent(sample()), 40);
});

test('computeCpuPercent falls back to the per-cpu array when online_cpus is absent', () => {
  const withoutOnlineCpus = sample();
  delete withoutOnlineCpus.cpu_stats.online_cpus;
  withoutOnlineCpus.cpu_stats.cpu_usage.percpu_usage = [1, 2];
  assert.equal(computeCpuPercent(withoutOnlineCpus), 20);
});

test('computeCpuPercent returns null rather than a fake 0 when it cannot know', () => {
  assert.equal(computeCpuPercent(null), null);
  assert.equal(computeCpuPercent({}), null);
  assert.equal(computeCpuPercent(sample({ precpu_stats: {} })), null);
  assert.equal(
    computeCpuPercent(
      sample({ precpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 100_000_000 } }),
    ),
    null,
    'a null system delta cannot produce a percentage',
  );
});

test('computeMemoryMb subtracts the page cache, as docker stats does', () => {
  assert.equal(computeMemoryMb(sample()), 150);
});

test('computeMemoryMb falls back to the cgroup v1 cache field', () => {
  assert.equal(
    computeMemoryMb(sample({ memory_stats: { usage: 200 * MB, stats: { cache: 20 * MB } } })),
    180,
  );
});

test('computeMemoryMb handles a sample without any cache information', () => {
  assert.equal(computeMemoryMb(sample({ memory_stats: { usage: 64 * MB } })), 64);
});

test('computeMemoryMb never reports a negative usage', () => {
  assert.equal(
    computeMemoryMb(
      sample({ memory_stats: { usage: 10 * MB, stats: { inactive_file: 40 * MB } } }),
    ),
    0,
  );
});

test('computeMemoryMb returns null when there is nothing to read', () => {
  assert.equal(computeMemoryMb(null), null);
  assert.equal(computeMemoryMb({ memory_stats: {} }), null);
});

test('summarizeStats returns both readings at once', () => {
  assert.deepEqual(summarizeStats(sample()), { cpuPercent: 40, memoryMb: 150 });
});
