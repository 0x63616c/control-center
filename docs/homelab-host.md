# The Homelab Host (the Mac mini) — RETIRED

> **Historical record.** The Mac mini described below was retired and powered
> off 2026-07-25; it is kept as a cold spare, not production. "prod" is now
> the `home-server` Talos node (`192.168.0.5`) — see `AGENTS.md`. This doc is
> left in place as a historical account of the mini's setup, not a live
> runbook. `scripts/ssh-homelab.sh` and `scripts/mount-homelab-drive.sh`,
> referenced below, were deleted in #140 as dead code; do not expect them to
> exist on disk.

Everything called "prod" ran on one machine: an **M2 Mac mini, 8 GB RAM, 8
cores**, hostname `captive-portal.worldwidewebb.co`, tailnet
`homelab.tail8c014d.ts.net`. There was no other production environment.

This doc exists because there wasn't one. Until 2026-07-24 the host's
configuration lived only *on the host* — hand-edited scripts, a LaunchAgent
nobody had read in months, and an OrbStack VM sized 1 GB above what the repo
claimed. Nothing was reviewable and nothing was checkable.

## Access

```sh
./scripts/ssh-homelab.sh 'uptime'      # run a command
./scripts/ssh-homelab.sh               # interactive shell
```

Uses a dedicated key from the SOPS vault and explicitly bypasses the 1Password
agent. **Do not** use bare `ssh homelab` in scripted contexts — that path wants a
1P unlock. `kubectl` needs `--context cc-homelab`; the default `orbstack` context
is the *local* Mac, not this one.

## The repo checkout on the mini

```
~/code/github.com/0x63616c/world-wide-webb
```

A **shallow (`--depth 1`), read-only** clone over public HTTPS — no credentials
on the box. It exists so the `--check` modes can actually run where the state
lives; before it existed, `provision-orbstack.sh --check` had **never once run on
the machine it describes**, which is why the memory drift went unnoticed.

Refresh it before running anything:

```sh
./scripts/ssh-homelab.sh 'cd ~/code/github.com/0x63616c/world-wide-webb && git pull --quiet && git log --oneline -1'
```

Scripts expected to be run *from* this checkout, on the box:

| Script | Purpose |
| --- | --- |
| `scripts/install-haos.sh` | Install HAOS start/stop scripts + LaunchAgent from `infra/homelab/haos/`. `--check` fails on drift. |
| `scripts/provision-orbstack.sh` | Size the OrbStack VM. `--check` reports drift; `--restart` forces an apply. |
| `scripts/install-orbstack-watchdog.sh` | Install the docker-hang watchdog LaunchAgent. |
| `scripts/mount-homelab-drive.sh` | Mount the Synology NFS share. |
| `scripts/install-ha-watchdog.sh` | Install the HA Core watchdog LaunchAgent. |
| `scripts/install-drift-check.sh` | Schedule every `--check` on a 6h interval. |
| `scripts/drift-check.sh` | Run every `--check` once, now. |

## Memory budget — the whole point

8 GB total, three tenants, **fully committed**:

```
  4096 MiB  OrbStack VM        scripts/provision-orbstack.sh  (TARGET_MEM_MIB)
+ 2048 MiB  Home Assistant VM  infra/homelab/haos/start-haos.sh (HAOS_MEM)
+ ~2048 MiB macOS itself
= 8192 MiB
```

**These are not independent.** Raising either VM requires lowering the other by
the same amount. The pre-2026-07-24 spec of 5120 for OrbStack forgot the HA guest
existed entirely, and the live box had additionally drifted to 6144. The result,
measured during the HA outage that morning: **60 MB free, 2.84 GB in the
compressor, 640 MB swapped.** After correcting to 4096 and quitting a stray
Safari session: compressor **1.97 GB**, swap **442 MB**.

Notes on reading `vm_stat` here:

- **"Pages free" is not a useful health metric.** macOS drives it to near zero by
  design. It sat at ~60 MB both before and after a change that measurably helped.
  Watch **"Pages occupied by compressor"** and `sysctl vm.swapusage` instead.
- Container memory caps live in `infra/src/services.ts` (~2.5 GB of limits
  total). VM size is headroom; the caps are the actual protection.

**No GUI browser session should be left running on the mini.** A forgotten Safari
window was holding a WebContent process at ~12% CPU. It is a headless server.

## What runs here

### launchd jobs (`~/Library/LaunchAgents/`)

| Label | What it does |
| --- | --- |
| `com.homeassistant.os` | Runs the HAOS QEMU guest via `~/homeassistant-os/start-haos.sh`. `KeepAlive{SuccessfulExit:false}`, `ThrottleInterval 30`. Logs to `/tmp/haos-launch.log`. |
| `com.homeassistant.proxy` | `socat *:8123 → 192.168.0.38:8123`, exposing HA on the tailnet host port. |
| `com.unifi.proxy` | Same pattern for the UniFi controller (`:8444`). |
| `co.worldwidewebb.orbstack-watchdog` | Probes `docker info`; hard-restarts OrbStack on a sustained hang. See `scripts/orbstack-watchdog.sh`. |
| `co.worldwidewebb.ha-watchdog` | Probes HA Core on `:8123` every 60s; after 3 consecutive failures restarts the HAOS guest **cleanly**, once per 15min at most. `scripts/ha-watchdog.sh`, log at `~/.local/state/ha-watchdog/watchdog.log` (silent while healthy). |
| `co.worldwidewebb.drift-check` | Every 6h, pulls the checkout and runs every `--check`. Non-zero `launchctl list` status = drift; log at `~/.local/state/drift-check/drift.log`. |
| `com.calum.k8s-apiserver-forward` | Forwards the k8s API server port. |
| `com.0x63616c.zero`, `com.0x63616c.zero.sampler` | Unrelated to this stack; not documented here. |

Because `KeepAlive` is `{SuccessfulExit: false}` and `start-haos.sh` exits **0**
when the VM is already running, launchd will **not** notice a QEMU that dies
later — and it would not have helped on 2026-07-24 anyway, when QEMU stayed
alive and only *Core inside it* died. `co.worldwidewebb.ha-watchdog` closes that
gap by probing `:8123` itself.

To restart a job: `launchctl kickstart -k gui/$(id -u)/<label>`.

### The OrbStack VM

Hosts the k3s cluster and every container in `control-center` (api, web, worker,
postgres/`control-center-1`, go2rtc, plex, purge CronJobs). Restarting it
restarts all of them — roughly a 3-minute window before every pod is `Running`
again, during which api/worker crash-loop while postgres comes up. That is
expected, not a fault.

Apply a size change with `./scripts/provision-orbstack.sh` (or `--restart` if the
config already matches but the running VM doesn't). It refuses to restart unless
the NFS mount is healthy first — an ordering bug where OrbStack's file-share of a
missing NFS mount wedges dockerd.

### The Home Assistant VM

A separate QEMU guest at `192.168.0.38`, **not** in OrbStack — so bouncing
OrbStack does not touch Home Assistant, and vice versa. Full detail, including
the serial console and the clean-shutdown path, is in
[`ha-homelab.md`](./ha-homelab.md).

### NFS

`192.168.0.218:/volume1/Homelab` → `/Users/calum/control-center/media`, mounted
on the host and bind-mounted into containers. Must be up *before* OrbStack
starts.

## Drift checking

```sh
./scripts/ssh-homelab.sh 'cd ~/code/github.com/0x63616c/world-wide-webb && git pull -q &&
  ./scripts/install-haos.sh --check && ./scripts/provision-orbstack.sh --check'
```

Both exit non-zero on drift. This is the only thing standing between the repo's
description of the host and the host's actual state — the 2026-07-24 outage is
what it costs when nobody runs it. Since then `co.worldwidewebb.drift-check`
runs exactly this every 6h, so it is no longer something a human has to remember.

## Cluster observability

`metrics-server` is installed by Pulumi (`infra/src/metrics-server.ts`), so
`kubectl --context cc-homelab top nodes` / `top pods -n control-center` work.
OrbStack's k3s does not ship it; before 2026-07-24 the cluster had no CPU or
memory numbers at all. It is a **live** window only — it stores no history.
