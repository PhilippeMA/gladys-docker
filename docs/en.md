# Docker

Manage the Docker containers of your server from Gladys: see whether they run,
start and stop them from a dashboard or a scene, restart them from the
Configuration screen, and follow their CPU and memory usage.

## How it connects to Docker

Gladys runs every external integration in a sandboxed container that **cannot
mount a path of your host**, and `/var/run/docker.sock` is a host path. So this
integration does not use the Docker socket: it talks to the **Docker Engine
API over your network**, at an address you provide.

You have two ways to expose that API. The first one is strongly recommended.

### Option A — a socket proxy (recommended)

A socket proxy sits in front of the Docker socket and only forwards the calls
you allow. Even if something else on your network reached it, it could not
create a privileged container on your host.

Add this to a `docker-compose.yml` on the machine that runs your containers:

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
      CONTAINERS: 1 # list the containers (required)
      POST: 1 # allow start / stop / restart
```

Then `docker compose up -d`, and use `http://<ip-of-that-machine>:2375` as the
address below.

Two notes on those permissions:

- `CONTAINERS: 1` alone gives a **read-only** integration: states, CPU and
  memory work, the On/Off switch and the restart button do not.
- `POST: 1` is what allows starting, stopping and restarting. It is scoped to
  the endpoints the proxy exposes, so it does not grant container creation.

The proxy has no authentication of its own: publish its port on a network you
trust, and never on the public internet.

### Option B — the Docker daemon itself

If your daemon already listens on TCP (`-H tcp://0.0.0.0:2375`, or a
`hosts` entry in `/etc/docker/daemon.json`), point the integration straight at
it. Be aware that an unprotected Docker API grants **full root-equivalent
access** to that machine: only do this on a trusted network, and prefer
option A.

`https://` addresses are supported. Client certificates (`--tlsverify` with a
client key pair) are not: if your daemon requires them, put a socket proxy in
front of it instead.

## Configuration

1. Open the **Configuration** tab of the integration.
2. **Docker API address** — for example `http://192.168.1.10:2375`. The
   `tcp://host:port` form the Docker CLI uses and a bare `host:port` are
   accepted too.
3. Click **Test the Docker connection**. It answers with the Docker version and
   how many containers match your filters. Fix this before going further:
   nothing else works until it succeeds.
4. **Containers to include / to exclude** — comma-separated names where `*`
   matches anything, for example `media-*, nginx`. Leaving the inclusion list
   empty exposes every container. The exclusion list is applied last and
   defaults to `gladys*`, so the containers running Gladys itself are kept out
   of reach — controlling them from Gladys would let you stop the very thing
   holding the switch.
5. Click **List the matching containers** to check your filters before saving.
6. Save: the containers appear in the **Discovery** tab, ready to be added.

The other settings:

| Setting                  | What it changes                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offer stopped containers | Whether containers that are currently stopped are listed in Discovery.                                                                                                |
| Collect CPU and memory   | Adds a CPU and a memory sensor to each container. Costs about a second of daemon time per refresh.                                                                    |
| Refresh interval         | How often the state and the sensors of a container are refreshed. Gladys polls a device once a minute at the slowest, so the choices run from 10 seconds to 1 minute. |
| Discovery interval       | How often the container list is re-read, so containers created later appear on their own. This is the integration's own timer, unrelated to the refresh interval.     |
| Stop timeout             | The grace period Docker gives a container to exit before killing it.                                                                                                  |

## What each container looks like in Gladys

| Feature | Type       | What it does                                             |
| ------- | ---------- | -------------------------------------------------------- |
| On/Off  | Switch     | Starts and stops the container. Usable in scenes.        |
| State   | Text       | `running`, `exited`, `restarting`, `paused`…             |
| CPU     | Percentage | Same scale as `docker stats`: 200% means two full cores. |
| Memory  | Megabytes  | Working memory, page cache excluded.                     |

Containers created by Docker Compose are named `project · service`; the others
keep their container name. The device page also shows the image the container
runs and, for a Compose container, its project and service.

A device carries a **local** badge, which turns orange when the container needs
attention — restarting in a loop, paused, dead, or failing its own health check
— and grey when the daemon can no longer be reached.

## Actions

- **Test the Docker connection** — contacts the daemon and reports its version,
  its platform and how many containers your filters select.
- **List the matching containers** — shows exactly what your inclusion and
  exclusion filters select right now. The fastest way to understand why a
  container does or does not show up.
- **Restart a container** — pick one of your containers and restart it, without
  having to build a stop-then-start scene.

## Good to know

- **Containers are tracked by name, not by id.** `docker compose up` after an
  image update recreates a container with a brand new id but the same name, so
  your devices, their history and the scenes using them survive the update.
- **A container renamed is a new device.** Rename a container and Gladys sees
  the old device disappear and a new one show up in Discovery.
- **Stopped containers stay controllable.** Hiding stopped containers only
  changes what Discovery offers; a device you already added keeps its switch
  and can be started again.
- **The state published is the daemon's, not the request's.** Start a container
  that crashes on boot and the switch goes back to off, because that is what
  Docker reports.
- **Collecting CPU and memory is not free.** Docker needs about a second to
  answer a stats request, per container. With twenty containers refreshed every
  10 seconds, the daemon spends more time answering than idling: leave the
  refresh interval at one minute unless you have few containers, or turn the
  stats off.

## Troubleshooting

**"Cannot reach the Docker API"** — the address is wrong, the port is not
published, or a firewall drops the connection. From another machine on the same
network, `curl http://<address>/version` should answer some JSON.

**"Docker API returned a non-JSON body"** — something answered, but it was not
a Docker API: usually a web server or a router page on that port.

**"Docker API 403"** — a socket proxy is refusing the call. Add the permission
it needs: `CONTAINERS: 1` to list, `POST: 1` to start, stop and restart.

**No container in Discovery** — click **List the matching containers**. An
empty answer means your filters exclude everything; remember the exclusion
list defaults to `gladys*`.

**The CPU is missing but the memory is there** — a container needs two
consecutive readings before a CPU percentage can be computed. One is missing
just after a start; the next refresh has it.

The integration logs everything it does. Set `LOG_LEVEL=debug` to see every
call it makes to the Docker API, then read the integration logs from the Gladys
UI (or `docker logs` on the host).
