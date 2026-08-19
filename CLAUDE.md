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
