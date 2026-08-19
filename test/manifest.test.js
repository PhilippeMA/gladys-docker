// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest shape is validated by the store indexer, but nothing there knows
// which handlers the code registers nor which defaults it applies — these tests
// keep the two in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, GLADYS_POLL_FREQUENCIES, normalizeConfig } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

// Every action key index.js registers a handler for, read from the source so a
// handler removed there fails this test rather than the user's button.
const entryPoint = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      entryPoint.includes(`gladys.onAction('${action.key}'`),
      `manifest action "${action.key}" has no handler in index.js`,
    );
  }
});

test('saving the form untouched gives the code exactly its own defaults', () => {
  // Stronger than comparing raw values field by field: a `select` stores its
  // option values as strings, so what matters is that the manifest defaults,
  // once normalized, ARE the defaults the code assumes.
  const asSubmitted = Object.fromEntries(
    manifest.config_schema
      .filter((field) => field.default !== undefined)
      .map((field) => [field.key, field.default]),
  );
  assert.deepEqual(normalizeConfig(asSubmitted), DEFAULT_CONFIG);
});

test('every value-carrying config field is known to the code', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(
      field.key in DEFAULT_CONFIG,
      `config field "${field.key}" is missing from DEFAULT_CONFIG`,
    );
  }
});

test('the numeric bounds of the manifest match the clamping the code applies', () => {
  const bounded = manifest.config_schema.filter((field) => field.type === 'number');
  assert.ok(bounded.length > 0);
  for (const field of bounded) {
    assert.ok(
      field.min !== undefined && field.max !== undefined,
      `${field.key} must declare min and max`,
    );
    assert.ok(
      field.min <= field.default && field.default <= field.max,
      `${field.key} default out of range`,
    );
  }
});

test('the refresh interval only offers frequencies Gladys accepts', () => {
  // Gladys validates poll_frequency against a closed list of MILLISECOND
  // values and rejects the entire discovery payload when one is off. Offering
  // a free number here is what let a seconds-shaped value through.
  const field = manifest.config_schema.find((f) => f.key === 'poll_frequency');
  assert.equal(field.type, 'select', 'a free number can express a frequency Gladys refuses');
  for (const option of field.options) {
    assert.ok(
      GLADYS_POLL_FREQUENCIES.includes(Number(option.value)),
      `option "${option.value}" is not a frequency Gladys accepts`,
    );
  }
  assert.ok(field.options.some((option) => option.value === field.default));
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // Older cores reject any unknown manifest field, so a manifest declaring
  // `categories` must not claim compatibility below the first release that
  // accepts it — the store validator enforces the same coupling.
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((field) => field.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the configuration the code manipulates.
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.equal(section.placeholder, undefined);
    assert.ok(section.label?.en);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the restart action targets a device through the core-filled select', () => {
  const restart = manifest.actions.find((action) => action.key === 'restart_container');
  const [field] = restart.fields;
  assert.equal(field.source, 'devices', 'the only core-defined source in V1 is "devices"');
  assert.equal(
    field.options,
    undefined,
    'declaring source and options together rejects the manifest',
  );
  assert.equal(field.default, undefined, 'a dynamic source accepts no default');
});

test('the manifest version and the package version stay in lockstep', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'the published image tag must be the manifest version',
  );
});

test('the integration declares a single, local transport', () => {
  // Everything goes through the Docker API of a machine on the user's network:
  // there is no cloud channel, hence no "prefer local" toggle to render.
  assert.deepEqual(manifest.transports, ['local']);
});
