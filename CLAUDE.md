# Working on this integration

Gladys integration for Docker container management. Read this before touching
anything that gets published to Gladys.

## Run the checks

```bash
npm test              # node --test, offline, ~1s
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store .   # store admission rules
```

`npm test` is the gate that matters: it replays the Gladys core's own
admission rules against the payload we would really send
(`test/helpers/gladysContract.js`). Never change what a device or a feature
looks like without running it.

## The Gladys device contract — read this, do not infer it

The SDK types are permissive and the official template is not a specification.
Fields the template omits are still required, and values it uses are not always
accepted. Every rule below was learned from a production rejection.

**There are TWO validation gates, and passing the first says nothing about the
second.**

1. `publishDiscoveredDevices` → `externalIntegration.setDiscoveredDevices`.
   Checks external id prefixes, `poll_frequency`, categories, types, units.
   It validates the WHOLE list and rejects all of it on the first bad field:
   **one wrong value on one device costs every device of the integration.**
2. The user clicks "add" in the Discovery tab → `POST /device` →
   `device.create` → the Sequelize models. This is where the NOT NULL columns
   are enforced. A payload sails through gate 1 and is refused here, possibly
   days later, when someone finally adds the device — the worst moment to find
   out.

### `poll_frequency` is milliseconds, from a closed list

`DEVICE_POLL_FREQUENCIES` in the core: **1000, 2000, 10000, 15000, 30000,
60000**. Nothing else. Note the ceiling — one minute is as slow as a device can
be polled — and the unit: `60` reads as a sensible minute and is rejected with
`devices[0].poll_frequency: invalid poll frequency`, taking the whole payload
with it.

Never expose this as a free number in the manifest. It is a `select` over
`GLADYS_POLL_FREQUENCIES` (`src/config.js`), and `normalizeConfig` falls back
to the default rather than forwarding anything off-list.

Anything the integration schedules itself (the discovery loop) is unrelated and
free — it never reaches Gladys.

### Every feature needs `min` and `max`

`t_device_feature` declares both NOT NULL. This applies to **every** feature,
including ones where a numeric range is meaningless. Omitting them publishes
fine and then fails at creation with
`t_device_feature.min cannot be null; t_device_feature.max cannot be null`.

Follow the values Gladys assigns itself (`getFeatureDefaultValues` in the
front-end):

| Feature            | min | max | note                         |
| ------------------ | --- | --- | ---------------------------- |
| `switch`/`binary`  | 0   | 1   |                              |
| `light`/`binary`   | 0   | 1   |                              |
| `text`/`text`      | 0   | 0   | also `keep_history: false`   |
| percentage sensors | 0   | 100 | unless the scale exceeds 100 |

The full list of NOT NULL feature columns the integration must supply:
`name`, `external_id`, `category`, `type`, `read_only`, `has_feedback`,
`min`, `max`. (`keep_history` has a default; `unit` and `step` are nullable,
and `step` must be `> 0` when present.)

### A device is not polled unless it says so

`t_device.should_poll` defaults to **false**, and `device.add` only schedules a
device when `should_poll === true && poll_frequency`. Publishing a frequency
alone creates a device Gladys accepts, creates, and then never polls — every
feature stays empty forever, with nothing in any log to explain it. Publish
both.

### Rendering is decided by the category/type pair, not by your names

Two front-end maps, both keyed by `category.type`, decide what a feature looks
like — and a feature name you chose is usually ignored:

- the icon comes from `DeviceFeatureCategoriesIcon`. **A sensor row has no
  fallback**: a missing pair renders `fe-undefined`, i.e. no icon at all.
  (Push buttons and selects do have a fallback.)
- the row label comes from the i18n key `deviceFeatureCategory.<category>.<type>`
  — _unless_ another feature of the same device shares the same `type`, in
  which case Gladys falls back to the feature `name`. That quirk
  (`shouldDisplayDeviceName`) is why the three push buttons show "Start",
  "Stop" and "Restart" rather than a generic wording.

Check both maps before choosing a pair. `unknown`/`decimal` exists server-side
and renders blank, which is how the CPU feature shipped without an icon or a
label.

Those two rules combine into the trick this integration relies on: borrow a
category for its **icon**, then give a sibling feature the **same type** so the
borrowed category's wrong label never shows. CPU and Memory are both `decimal`
for exactly that reason, as are the three `push` buttons. Give either stats
feature a unique type again and both rows revert to the category wording.

`read_only` decides the whole widget: `true` routes to the sensor renderer
(a badge), `false` to a control — a toggle, a push button, a select.

### Categories and types are validated independently

Both are flat ENUM lists — the core never checks that a type belongs to its
category, and no server-side rule couples the unit to either. That is why
`unknown` + `decimal` + `percent` (the CPU feature) is accepted.

### Everything else

- External ids must start with `ext:<selector>:`; always build them with
  `gladys.externalIds(type, platformId)`.
- Device `params`: `name` and `value` are both NOT NULL and `value` is a
  string. The `GLADYS_` prefix is reserved to the core.
- Max 2000 devices in one discovery payload.
- `supported_options`: every option needs a non-empty string `label` (one
  language only, no multi-language object) and values must be unique. String
  values are accepted **only** on a `text`/`select` feature; anywhere else the
  core refuses the state later. They are upserted onto already-created devices
  on every re-publish, which is the only way to make a control's choices follow
  a device's state.
- `setConnectionStatus` messages need an `en` key; every value must be a string.

## Checking a rule rather than guessing it

The core is the source of truth, and it is cheap to consult:

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/GladysAssistant/Gladys.git
cd Gladys && git sparse-checkout set server front/src
```

- `server/models/device*.js` — the NOT NULL columns and ENUMs
- `server/utils/constants.js` — `DEVICE_POLL_FREQUENCIES`, categories, types, units
- `server/lib/external-integration/externalIntegration.setDiscoveredDevices.js`
  — gate 1, field by field
- `front/src/routes/integration/all/mqtt/device-page/utils.js`
  (`getFeatureDefaultValues`) — the min/max/read_only conventions per
  category and type
- `front/src/utils/consts.js` (`DeviceFeatureCategoriesIcon`),
  `front/src/config/i18n/fr.json` (`deviceFeatureCategory`) and
  `front/src/components/boxs/device-in-room/DeviceRow.jsx` — which pairs
  actually render, and as what

When a new rule is found, mirror it in `test/helpers/gladysContract.js` and add
it above. A rule that only lives in a commit message will be broken again.

## Conventions of this codebase

- Containers are keyed by **name**, never by id: `docker compose up` after an
  image update recreates a container with a new id and the same name, and
  keying on the id would make every update look like a device disappearing.
- The container list is read once and shared for a few seconds
  (`LIST_CACHE_TTL_MS`): Gladys polls each device independently. Commands pass
  `{ force: true }` so they read their own effect.
- `refreshDevices` in `index.js` is the only caller of `setConnectionStatus`,
  so nothing may escape it — an exception on the way out leaves the
  Configuration screen showing a stale failure long after the cause is fixed.
- The Docker API surface is deliberately confined to `src/docker/api.js`, so
  the permissions a socket proxy must grant stay readable in one place.
