// -----------------------------------------------------------------------------
// Widget `container`: one container, with its controls.
//
// This is the card that acts. Its three buttons are bound to the push features
// the devices already carry (`device_feature` + `value: 1`), so the tap travels
// the standard device path: Gladys sends the command, shows the button active
// while it runs, and the integration handles it in onSetValue exactly as it
// handles a tap on the device page. Nothing to re-implement, nothing to keep in
// sync.
//
// The CPU and memory tiles are bound the same way: the core follows the
// published states, so they move on their own between two widget reads.
// -----------------------------------------------------------------------------

import { containerExternalIds, FEATURE } from '../devices/container.js';
import { labelsFor } from './i18n.js';
import { bound, containerColor, containerIcon, WIDGET_LIMITS } from './format.js';

/** Widget key, as declared in the manifest. */
export const KEY = 'container';

/**
 * The three orders, as buttons bound to the device features that carry them.
 * @param {object} ids - External ids of the container's device.
 * @param {object} labels - Localized words.
 * @returns {object[]} `button` components.
 */
function buildButtons(ids, labels) {
  return [
    {
      type: 'button',
      label: bound(labels.start, WIDGET_LIMITS.BUTTON_LABEL),
      icon: 'play',
      style: 'primary',
      device_feature: ids.feature(FEATURE.START),
      value: 1,
    },
    {
      type: 'button',
      label: bound(labels.stop, WIDGET_LIMITS.BUTTON_LABEL),
      icon: 'square',
      style: 'danger',
      device_feature: ids.feature(FEATURE.STOP),
      value: 1,
    },
    {
      type: 'button',
      label: bound(labels.restart, WIDGET_LIMITS.BUTTON_LABEL),
      icon: 'refresh-cw',
      style: 'secondary',
      device_feature: ids.feature(FEATURE.RESTART),
      value: 1,
    },
  ];
}

/**
 * The rows describing what the container is, under the tiles.
 * @param {object} container - Normalized container.
 * @param {object} labels - Localized words.
 * @returns {object} A `status` component.
 */
function buildStatus(container, labels) {
  const items = [
    {
      label: labels.state,
      value: bound(container.status || container.state, WIDGET_LIMITS.STATUS_VALUE),
      icon: containerIcon(container),
      color: containerColor(container),
    },
    { label: labels.image, value: bound(container.image, WIDGET_LIMITS.STATUS_VALUE) },
  ];

  if (container.composeProject && container.composeService) {
    items.push({
      label: labels.compose,
      value: bound(
        `${container.composeProject} · ${container.composeService}`,
        WIDGET_LIMITS.STATUS_VALUE,
      ),
    });
  }
  return { type: 'status', items };
}

/**
 * Build the content of the single-container widget.
 * @param {object} gladys - SDK instance.
 * @param {object} registry - Registry.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @param {object} options - What Gladys sent with the request.
 * @param {object} options.settings - Instance settings.
 * @param {string} options.language - Requesting user's language.
 * @returns {Promise<object>} A widget content.
 */
export async function buildContainerContent(gladys, registry, config, { settings = {}, language }) {
  const labels = labelsFor(language);
  const externalId = settings.device;

  // A freshly dropped widget has no device yet: say what to do rather than
  // render a card of blanks.
  if (!externalId) {
    return { ttl_seconds: 60, components: [{ type: 'text', text: labels.pickContainer }] };
  }

  try {
    await registry.list(config);
  } catch {
    return { ttl_seconds: 30, components: [{ type: 'text', text: labels.unreachable }] };
  }

  const container = registry.findByExternalId(externalId);
  if (!container) {
    return { ttl_seconds: 60, components: [{ type: 'text', text: labels.goneContainer }] };
  }

  const ids = containerExternalIds(gladys, container.name);
  const components = [];

  // Bound tiles only exist when the features do: with the stats collection
  // turned off, the device carries no CPU nor memory feature and the core
  // would drop the components anyway.
  if (config.collect_stats) {
    components.push(
      {
        type: 'value',
        device_feature: ids.feature(FEATURE.CPU),
        label: labels.cpu,
        icon: 'cpu',
      },
      {
        type: 'value',
        device_feature: ids.feature(FEATURE.MEMORY),
        label: labels.memory,
        icon: 'server',
      },
    );
  }

  components.push(buildStatus(container, labels), ...buildButtons(ids, labels));

  return { ttl_seconds: 60, components };
}
