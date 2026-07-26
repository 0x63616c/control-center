#!/usr/bin/env bash
#
# Provisions the OrbStack VM on homelab to the spec this stack needs (www-jagy).
# Run ON homelab, as calum (NOT sudo , `orb config` is per-user):
#
#   ./scripts/provision-orbstack.sh           # apply
#   ./scripts/provision-orbstack.sh --check    # report only, change nothing
#
# Idempotent. Codifies what was previously a manual `orb config set` so the VM
# sizing survives a reinstall and is reviewable. Applying a memory change needs an
# OrbStack restart , this script bounces it ONLY if the value actually changed,
# and only after confirming the host NFS mount is up first (see ordering note).

set -euo pipefail

# --- target spec -------------------------------------------------------------
# 4GB VM (memory_mib=4096). The box is 8GB and OrbStack is NOT its only tenant:
#
#     4096 MiB  OrbStack VM        (this script)
#   + 2048 MiB  Home Assistant VM  (infra/homelab/haos/start-haos.sh, HAOS_MEM)
#   + ~2048 MiB macOS itself
#   = 8192 MiB
#
# The previous 5120 target forgot the HAOS guest entirely, so the arithmetic only
# ever balanced on paper. In practice the live box had ALSO drifted to 6144 with
# nobody noticing , there was no repo checkout on the mini, so `--check` had never
# once run there. On 2026-07-24 that left the host with 60MB free and 640MB
# swapped while HA Core was down. Raising this value means lowering HAOS_MEM by
# the same amount; the two VMs are not independent.
#
# The real protection against a single container eating the VM is the per-service
# memory caps in deploy.config.ts (www-ke9a), NOT VM size , this is headroom, not
# the fix.
TARGET_MEM_MIB="${TARGET_MEM_MIB:-4096}"
# vCPUs kept at 8 (all cores). Decision: an RCU-stall came from a container
# pegging all cores AND starving the guest kernel, but the memory caps + watchdog
# (www-sizh) address that more directly than under-provisioning CPU would; dropping
# to 6 only helps if macOS itself is starved, which it isn't. Revisit if the host
# (not the VM) shows CPU starvation.
TARGET_CPU="${TARGET_CPU:-8}"

NFS_MOUNT="/Users/calum/control-center/media"
CHECK_ONLY=0
FORCE_RESTART=0
case "${1:-}" in
  --check)   CHECK_ONLY=1 ;;
  --restart) FORCE_RESTART=1 ;;
  "")        ;;
  *) echo "usage: $(basename "$0") [--check|--restart]" >&2; exit 2 ;;
esac

[ "$(id -u)" -ne 0 ] || { echo "FATAL: run as calum, NOT sudo (orb config is per-user)" >&2; exit 1; }
command -v orb >/dev/null || { echo "FATAL: orb (OrbStack CLI) not on PATH" >&2; exit 1; }

cur_mem="$(orb config show 2>/dev/null | awk '/memory_mib:/{print $2}')"
cur_cpu="$(orb config show 2>/dev/null | awk '/cpu:/{print $2}')"
echo "current: memory_mib=${cur_mem:-?} cpu=${cur_cpu:-?}  target: memory_mib=$TARGET_MEM_MIB cpu=$TARGET_CPU"

if [ "$CHECK_ONLY" -eq 1 ]; then
  [ "$cur_mem" = "$TARGET_MEM_MIB" ] && [ "$cur_cpu" = "$TARGET_CPU" ] && { echo "in spec"; exit 0; }
  echo "OUT OF SPEC (run without --check to apply)"; exit 1
fi

changed=0
[ "$cur_cpu" = "$TARGET_CPU" ] || { orb config set cpu "$TARGET_CPU"; changed=1; echo "set cpu=$TARGET_CPU"; }
[ "$cur_mem" = "$TARGET_MEM_MIB" ] || { orb config set memory_mib "$TARGET_MEM_MIB"; changed=1; echo "set memory_mib=$TARGET_MEM_MIB"; }

if [ "$changed" -eq 0 ] && [ "$FORCE_RESTART" -eq 0 ]; then
  echo "already in spec , no restart needed"
  echo "(if the RUNNING VM still has the old sizing, re-run with --restart)"
  exit 0
fi

# WHY --restart EXISTS: `changed` only tracks whether this run edited the CONFIG,
# not whether the running VM matches it. Those diverge whenever a previous run set
# the value but failed to apply it , exactly what the broken `orb restart` bug
# below caused. Without an explicit way to force the apply, the script would
# cheerfully report "already in spec" forever while the live VM kept the old size.
[ "$FORCE_RESTART" -eq 1 ] && [ "$changed" -eq 0 ] && \
  echo "--restart: config already at target, forcing the apply/restart anyway"

# ORDERING (www-6mz7): OrbStack must establish its file-share of the host NFS mount
# AFTER that NFS mount is up, or its container bind-mount of $NFS_MOUNT hangs and
# wedges dockerd (a SECOND, distinct 1033 cause we hit on 2026-06-09). So before
# restarting OrbStack to apply the config, confirm the host NFS mount is healthy.
echo "verifying host NFS mount before restarting OrbStack..."
if ! mount | grep -q " ${NFS_MOUNT} "; then
  echo "FATAL: $NFS_MOUNT is not mounted , mount the Synology NFS share first" >&2
  echo "       (restarting OrbStack without the NFS mount up re-triggers www-6mz7)" >&2
  exit 1
fi
# Cheap liveness probe of the share itself (must not hang).
( ls "$NFS_MOUNT" >/dev/null 2>&1 ) & p=$!; sleep 5
if kill -0 "$p" 2>/dev/null; then kill -9 "$p" 2>/dev/null; echo "FATAL: $NFS_MOUNT hangs on ls , NFS share unhealthy, fix before restarting OrbStack" >&2; exit 1; fi

echo "host NFS healthy , restarting OrbStack to apply config..."

# BUG FIXED 2026-07-24: this used to be a bare `orb restart`, which is invalid ,
# `orb restart` requires a machine ID/name and exits non-zero with "no machines
# specified". So this script could set the config value but NEVER apply it, and
# since the apply step was the last line the failure was easy to miss. That is
# the likeliest reason the live box sat at memory_mib=6144 while the repo claimed
# 5120: someone set it by hand, and the script was incapable of correcting it.
#
# Bare `orb stop` (no args, no -f) stops the ENTIRE OrbStack service gracefully,
# which is what applying a VM config change requires. -f is deliberately NOT used:
# `orb stop --help` warns it "may cause data loss", and postgres lives in here.
orb stop
for _ in $(seq 1 30); do
  orb status 2>/dev/null | grep -qi running || break
  sleep 2
done
orb start

# Don't claim success until docker actually answers again.
echo "waiting for docker to come back..."
ok=0
for _ in $(seq 1 60); do
  if docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" -eq 1 ] || { echo "FATAL: docker did not recover within 120s of restart" >&2; exit 1; }

echo "docker healthy. now: $(orb config show 2>/dev/null | awk '/memory_mib:|cpu:/{printf "%s%s ", $1, $2}')"
echo "done. verify: docker run --rm -v $NFS_MOUNT:/m alpine ls /m"
