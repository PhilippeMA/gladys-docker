// -----------------------------------------------------------------------------
// Widget `containers`: every container at a glance.
//
// The shape is dictated by the content budget (8 components; 6 tiles; ONE
// status; 4 buttons): five tiles for the totals, then one status list for the
// containers themselves. There is no component in the vocabulary that carries a
// control per row, which is why the per-container buttons live in the other
// widget rather than here.
//
// Numbers come from the last poll (registry.statsFor), never from a fresh stats
// call: a dashboard opening would otherwise cost one second of daemon time per
// container, every time.
// -----------------------------------------------------------------------------

import { isDegraded, isRunning } from '../docker/containers.js';
import { labelsFor } from './i18n.js';
import {
  bound,
  containerColor,
  containerIcon,
  containerSummary,
  formatMemory,
  WIDGET_LIMITS,
} from './format.js';

/** Widget key, as declared in the manifest. */
export const KEY = 'containers';

/** Action key of the contextual restart button. */
export const RESTART_ACTION = 'restart_container';

/** Rows a status component accepts. The last one may become "+N more". */
const MAX_ROWS = 10;

/**
 * Order the containers of the list. The default puts what deserves a look
 * first: a container in a restart loop is the reason someone opens this card,
 * and it must not sit below ten healthy ones.
 * @param {object[]} containers - Normalized containers.
 * @param {object} registry - Registry, for the last readings.
 * @param {string} sort - The `sort` setting.
 * @returns {object[]} A sorted copy.
 */
export function sortContainers(containers, registry, sort) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const copy = [...containers];

  if (sort === 'name') {
    return copy.sort(byName);
  }
  if (sort === 'cpu' || sort === 'memory') {
    const key = sort === 'cpu' ? 'cpuPercent' : 'memoryMb';
    return copy.sort((a, b) => {
      const left = registry.statsFor(a.name)[key] ?? -1;
      const right = registry.statsFor(b.name)[key] ?? -1;
      return right - left || byName(a, b);
    });
  }
  // 'state' (default): degraded, then stopped, then running.
  const rank = (container) => (isDegraded(container) ? 0 : isRunning(container) ? 2 : 1);
  return copy.sort((a, b) => rank(a) - rank(b) || byName(a, b));
}

/**
 * The tiles: what the whole set of containers adds up to.
 * @param {object[]} containers - Normalized containers.
 * @param {object} registry - Registry, for the last readings.
 * @param {object} labels - Localized words.
 * @returns {object[]} `value` components.
 */
function buildTiles(containers, registry, labels) {
  const running = containers.filter(isRunning);
  const degraded = containers.filter(isDegraded);

  const totals = running.reduce(
    (acc, container) => {
      const { cpuPercent, memoryMb } = registry.statsFor(container.name);
      return {
        cpu: acc.cpu + (typeof cpuPercent === 'number' ? cpuPercent : 0),
        memory: acc.memory + (typeof memoryMb === 'number' ? memoryMb : 0),
      };
    },
    { cpu: 0, memory: 0 },
  );

  return [
    { type: 'value', value: containers.length, label: labels.containers, icon: 'box' },
    {
      type: 'value',
      value: running.length,
      label: labels.running,
      icon: 'play-circle',
      color: 'success',
    },
    // The fifth tile earns its place twice: it counts what is merely stopped
    // most of the time, and switches to what is misbehaving when something is.
    degraded.length > 0
      ? {
          type: 'value',
          value: degraded.length,
          label: labels.attention,
          icon: 'alert-triangle',
          color: 'warning',
        }
      : {
          type: 'value',
          value: containers.length - running.length,
          label: labels.stopped,
          icon: 'stop-circle',
        },
    {
      type: 'value',
      value: Math.round(totals.cpu * 10) / 10,
      unit: '%',
      label: labels.totalCpu,
      icon: 'cpu',
    },
    {
      type: 'value',
      value: formatMemory(totals.memory) ?? '0 MB',
      label: labels.totalMemory,
      icon: 'server',
    },
  ];
}

/**
 * The status list, capped at ten rows: nine containers plus a "+N more" row
 * when the selection is longer, so the card never lies about what it shows.
 * @param {object[]} sorted - Sorted containers.
 * @param {object} registry - Registry, for the last readings.
 * @param {object} labels - Localized words.
 * @returns {object} A `status` component.
 */
function buildStatus(sorted, registry, labels) {
  const overflow = sorted.length - MAX_ROWS;
  const shown = overflow > 0 ? sorted.slice(0, MAX_ROWS - 1) : sorted;

  const items = shown.map((container) => ({
    label: bound(container.name, WIDGET_LIMITS.STATUS_LABEL),
    value: containerSummary(container, registry.statsFor(container.name), labels),
    icon: containerIcon(container),
    color: containerColor(container),
  }));

  if (overflow > 0) {
    items.push({ label: labels.others(overflow + 1), value: '…', icon: 'more-horizontal' });
  }
  return { type: 'status', items };
}

/**
 * Build the content of the overview widget.
 * @param {object} registry - Registry.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @param {object} options - What Gladys sent with the request.
 * @param {object} options.settings - Instance settings.
 * @param {string} options.language - Requesting user's language.
 * @returns {Promise<object>} A widget content.
 */
export async function buildContainersContent(registry, config, { settings = {}, language }) {
  const labels = labelsFor(language);

  try {
    await registry.list(config);
  } catch {
    // The card says why instead of rendering an empty state the user would
    // read as "no containers".
    return { ttl_seconds: 30, components: [{ type: 'text', text: labels.unreachable }] };
  }

  // The `containers` setting is a multi_select of our own devices: empty means
  // every container the filters already select.
  const chosen = Array.isArray(settings.containers) ? settings.containers : [];
  const all = registry.containers();
  const selected =
    chosen.length > 0 ? all.filter((c) => chosen.includes(registry.externalIdOf(c.name))) : all;

  if (selected.length === 0) {
    return { ttl_seconds: 60, components: [{ type: 'text', text: labels.noContainer }] };
  }

  const sorted = sortContainers(selected, registry, settings.sort);
  const components = [
    ...buildTiles(selected, registry, labels),
    buildStatus(sorted, registry, labels),
  ];

  // One container misbehaving is the case where a dashboard should let you act
  // without navigating away. More than one and there is no single right target,
  // so the card stays informative only.
  const degraded = selected.filter(isDegraded);
  if (degraded.length === 1) {
    components.push({
      type: 'button',
      label: bound(labels.restartOne(degraded[0].name), WIDGET_LIMITS.BUTTON_LABEL),
      icon: 'refresh-cw',
      style: 'secondary',
      action: {
        key: RESTART_ACTION,
        params: { container: degraded[0].name },
        confirm: true,
      },
    });
  }

  return { ttl_seconds: 60, components };
}
