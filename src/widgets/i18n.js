// -----------------------------------------------------------------------------
// The words the widgets put on screen.
//
// A widget content may carry multi-language objects, but `onWidgetGet` already
// receives the requesting user's language — and the core caches the content per
// language anyway. Resolving here keeps the component code readable and the
// payload small.
//
// English is the fallback: an unknown language falls back to it, as the core
// does with the `en` key of a multi-language object.
// -----------------------------------------------------------------------------

const LABELS = {
  en: {
    containers: 'Containers',
    running: 'Running',
    stopped: 'Stopped',
    attention: 'Needs attention',
    totalCpu: 'Total CPU',
    totalMemory: 'Total memory',
    cpu: 'CPU',
    memory: 'Memory',
    state: 'State',
    image: 'Image',
    compose: 'Compose',
    start: 'Start',
    stop: 'Stop',
    restart: 'Restart',
    others: (count) => `+${count} more`,
    restartOne: (name) => `Restart ${name}`,
    noContainer: 'No container matches your filters.',
    pickContainer: 'Pick a container in the widget settings.',
    unreachable: 'The Docker API cannot be reached.',
    goneContainer: 'This container no longer exists on the daemon.',
    restarted: (name) => `${name} restarted.`,
  },
  fr: {
    containers: 'Conteneurs',
    running: 'En marche',
    stopped: 'Arrêtés',
    attention: 'À surveiller',
    totalCpu: 'CPU total',
    totalMemory: 'Mémoire totale',
    cpu: 'CPU',
    memory: 'Mémoire',
    state: 'État',
    image: 'Image',
    compose: 'Compose',
    start: 'Démarrer',
    stop: 'Arrêter',
    restart: 'Redémarrer',
    others: (count) => `+${count} autres`,
    restartOne: (name) => `Redémarrer ${name}`,
    noContainer: 'Aucun conteneur ne correspond à vos filtres.',
    pickContainer: 'Choisissez un conteneur dans les réglages du widget.',
    unreachable: "L'API Docker est injoignable.",
    goneContainer: "Ce conteneur n'existe plus sur le daemon.",
    restarted: (name) => `${name} redémarré.`,
  },
};

/**
 * A toast message for a widget action, in every language we speak.
 *
 * Unlike `onWidgetGet`, an action handler is NOT told the user's language — so
 * the answer carries them all and the core picks, with `en` as the fallback.
 * @param {string} containerName - The container that was restarted.
 * @returns {object} A multi-language message.
 */
export function restartedMessage(containerName) {
  return {
    en: LABELS.en.restarted(containerName),
    fr: LABELS.fr.restarted(containerName),
  };
}

/**
 * The labels for a user's language, English when we do not speak it.
 * @param {string} language - ISO 639-1 code sent with the widget request.
 * @returns {object} Labels.
 */
export function labelsFor(language) {
  // 'fr-BE' and the like: the core sends ISO 639-1, but a region suffix costs
  // nothing to tolerate.
  const base = String(language ?? '')
    .slice(0, 2)
    .toLowerCase();
  return LABELS[base] ?? LABELS.en;
}
