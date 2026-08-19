// -----------------------------------------------------------------------------
// Turning a raw Docker stats sample into the two numbers a user cares about.
//
// Docker does not report a CPU percentage: it reports cumulative counters, and
// leaves the arithmetic to the client (`docker stats` does exactly what this
// file does). Memory needs care too — the raw `usage` counts the page cache,
// which makes an idle container look like it eats hundreds of megabytes.
// -----------------------------------------------------------------------------

/** Bytes in one megabyte, the unit the memory feature is published in. */
const BYTES_PER_MB = 1024 * 1024;

/**
 * CPU usage of a container, as a percentage of ONE core times the number of
 * cores — the same scale as `docker stats`, where a container saturating two
 * cores reads 200%.
 *
 * Returns null rather than 0 when the sample cannot answer: a container that
 * just started has no previous reading, and a flat 0% would silently lie.
 * @param {object} sample - Raw stats sample.
 * @returns {number|null} Percentage rounded to one decimal, or null.
 */
export function computeCpuPercent(sample) {
  const cpu = sample?.cpu_stats;
  const previous = sample?.precpu_stats;
  if (!cpu?.cpu_usage || !previous?.cpu_usage) {
    return null;
  }

  const cpuDelta = Number(cpu.cpu_usage.total_usage) - Number(previous.cpu_usage.total_usage);
  const systemDelta = Number(cpu.system_cpu_usage) - Number(previous.system_cpu_usage);
  if (!Number.isFinite(cpuDelta) || !Number.isFinite(systemDelta) || systemDelta <= 0) {
    return null;
  }

  const cores = Number(cpu.online_cpus) || cpu.cpu_usage.percpu_usage?.length || 1;
  const percent = (cpuDelta / systemDelta) * cores * 100;
  if (!Number.isFinite(percent) || percent < 0) {
    return null;
  }
  return Math.round(percent * 10) / 10;
}

/**
 * Memory actually used by a container, in megabytes.
 *
 * The page cache is subtracted from the raw usage, as `docker stats` does:
 * `inactive_file` on cgroup v2, `cache` on cgroup v1. Without it, a container
 * that once read a large file reports that file as memory it is using.
 * @param {object} sample - Raw stats sample.
 * @returns {number|null} Megabytes rounded to one decimal, or null.
 */
export function computeMemoryMb(sample) {
  const memory = sample?.memory_stats;
  const usage = Number(memory?.usage);
  if (!Number.isFinite(usage)) {
    return null;
  }
  const cache = Number(memory.stats?.inactive_file ?? memory.stats?.cache ?? 0);
  const used = usage - (Number.isFinite(cache) ? cache : 0);
  return Math.round((Math.max(used, 0) / BYTES_PER_MB) * 10) / 10;
}

/**
 * Both readings of one sample, in the units the features declare.
 * @param {object} sample - Raw stats sample.
 * @returns {{ cpuPercent: number|null, memoryMb: number|null }} Readings.
 */
export function summarizeStats(sample) {
  return { cpuPercent: computeCpuPercent(sample), memoryMb: computeMemoryMb(sample) };
}
