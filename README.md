# Gladys Docker integration

Manage the Docker containers of your server from
[Gladys Assistant](https://gladysassistant.com): one Gladys device per
container, showing whether it runs and what it consumes, with push buttons to
start, stop and restart it.

Built on the official
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
from the [JavaScript integration template](https://github.com/GladysAssistant/integration-template-js).

## What you get

| Feature                | Behaviour                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Running                | Read-only badge, plus the scene condition "if the container is running".                                           |
| State                  | `running`, `exited`, `restarting`, `paused`…                                                                       |
| Start / Stop / Restart | A push button each. Always all three — Gladys cannot hide a feature by state — and harmless to press in any state. |
| Action                 | A select offering only the orders the current state allows, kept in step through `supported_options`.              |
| CPU                    | Percentage, same scale as `docker stats`: 200% means two saturated cores.                                          |
| Memory                 | Megabytes, page cache excluded (as `docker stats` reports it).                                                     |

Plus three buttons in the Configuration screen: **Test the Docker connection**,
**List the matching containers** and **Restart a container**.

Containers are discovered on their own — the list is re-read on a timer, so a
container created after installation shows up without any action.

## How it reaches Docker

Gladys runs each external integration in a sandbox that mounts **no host path**,
so `/var/run/docker.sock` is out of reach by design. This integration talks to
the **Docker Engine API over the network** instead, at the address you give it.

The recommended setup is a socket proxy in front of the daemon, so the
integration can only do what you allowed:

```yaml
services:
  docker-proxy:
    image: ghcr.io/tecnativa/docker-socket-proxy:0.3.0
    restart: unless-stopped
    ports:
      - '2375:2375'
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      CONTAINERS: 1 # list containers (required)
      POST: 1 # allow start / stop / restart
```

Then set the integration's address to `http://<that-machine>:2375`. Pointing it
straight at a daemon listening on TCP works too — see [`docs/en.md`](./docs/en.md)
for the trade-offs, the `https://` support and the full walkthrough.

Exactly six endpoints are used, all of them listed at the top of
[`src/docker/api.js`](./src/docker/api.js): `GET /version`,
`GET /containers/json`, `GET /containers/{id}/stats`, and
`POST /containers/{id}/{start,stop,restart}`.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no Docker logic)
├─ src/
│  ├─ config.js                      # config defaults, normalization, clamping
│  ├─ registry.js                    # the live container list, shared and cached
│  ├─ commands.js                    # onPoll / onSetValue: read states, start, stop
│  ├─ actions.js                     # the buttons of the Configuration screen
│  ├─ docker/
│  │  ├─ client.js                   #   HTTP(S) / Unix-socket transport
│  │  ├─ api.js                      #   the six endpoints used, and nothing else
│  │  ├─ containers.js               #   normalization + include / exclude filters
│  │  └─ stats.js                    #   CPU % and memory, computed like docker stats
│  └─ devices/
│     └─ container.js                # what one container looks like to Gladys
├─ docs/en.md, docs/fr.md            # user documentation, re-hosted by Gladys
├─ gladys-assistant-integration.json # manifest (name, config schema, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI, multi-arch build, UI-driven release
```

Two design decisions are worth knowing before reading the code:

- **Containers are identified by name, not by id.** Recreating a container —
  what `docker compose up` does after an image update — gives it a new id and
  keeps its name. Keying devices on the id would make every image update look
  like "one device disappeared, a stranger appeared".
- **The container list is read once and shared for a few seconds.** Gladys
  polls each device independently; with twenty containers, the naive version
  would ask the daemon for the very same list twenty times in the same second.
  Commands bypass the cache, so a start still reads its own effect.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="docker" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs in its sandboxed container; the SDK reads them automatically.

Running it this way on a machine that has the Docker socket, you can also set
the address to `/var/run/docker.sock`: the client speaks to a Unix socket too,
which makes local development a one-liner. That path is not available to a
published integration.

## Quality checks

The same three gates run on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
npm run format:check   # Prettier: is everything formatted?
npm run lint           # ESLint: catch real mistakes
npm test               # Unit tests, via the built-in `node --test` runner
```

Tests live in [`test/`](test/) and use Node's native runner — no framework to
install. The Docker daemon and the Gladys server are both faked
([`test/helpers/`](test/helpers)), so the suite runs offline in under a second.

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

Runs the exact checks the store indexer applies — manifest schema, Docker image
availability, cover image, documentation — and reports every problem at once.

## Publishing

1. Add the GitHub topic `gladys-assistant-integration` to the repository.
2. **Actions → Release → Run workflow**, pick `patch`, `minor` or `major`. The
   workflow bumps the version in `package.json` and in the manifest (both
   `version` and the `docker_image` tag), pushes the `vX.Y.Z` tag and builds the
   `linux/amd64` + `linux/arm64` image to `ghcr.io`.
3. The decentralized indexer picks up the new version and Gladys offers a
   one-click install or update.

## Limitations

- **Client-certificate TLS is not supported.** A daemon behind `--tlsverify`
  with a client key pair needs a socket proxy in front of it.
- **Containers are managed, not created.** Starting, stopping and restarting an
  existing container is the whole scope: no `docker run`, no image pull, no
  recreation — those need a configuration this integration does not have.

## License

Apache-2.0
