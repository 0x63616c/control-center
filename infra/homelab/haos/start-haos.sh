#!/bin/bash
# Starts the Home Assistant OS QEMU guest on the homelab Mac mini.
#
# SOURCE OF TRUTH: this file. It is installed to ~/homeassistant-os/start-haos.sh
# by scripts/install-haos.sh; never hand-edit the copy on the box. launchd runs
# the installed copy via ~/Library/LaunchAgents/com.homeassistant.os.plist.
#
# launchd PATH lacks homebrew; qemu + socket_vmnet_client live there (CC-ob5o).
export PATH=/opt/homebrew/bin:/opt/homebrew/opt/socket_vmnet/bin:$PATH
HAOS_DIR="$HOME/homeassistant-os"
PIDFILE="$HAOS_DIR/haos.pid"
SOCKET="/opt/homebrew/var/run/socket_vmnet"
VMNET_LABEL="system/homebrew.mxcl.socket_vmnet"

# --- guest sizing ------------------------------------------------------------
# The host is an 8GB M2 mini shared with the OrbStack VM (see
# scripts/provision-orbstack.sh) and macOS itself. Budget:
#   4096 MiB OrbStack + 2048 MiB HAOS + ~2048 MiB macOS = 8192 MiB.
# Raising HAOS_MEM means lowering OrbStack's TARGET_MEM_MIB by the same amount;
# they are not independent. Kept as variables so guest sizing is a reviewable
# knob rather than a magic number buried in the QEMU invocation.
HAOS_MEM="${HAOS_MEM:-2G}"
HAOS_SMP="${HAOS_SMP:-4}"

# --- observability -----------------------------------------------------------
# WHY (2026-07-24): HA Core died and we had NO way to see why. The guest ran with
# `-serial null`, `:22222` debug SSH has no authorized key, and the observer on
# :4357 only exposes a health page — so there was no path to Core's logs and no
# way to restart Core without killing the whole VM.
#   -chardev file,append=on + -serial chardev:
#                  captures the guest console ACROSS BOOTS. The obvious
#                  `-serial file:PATH` TRUNCATES on every QEMU start, which we
#                  found out the hard way: the 08:26 recovery boot's log was
#                  silently destroyed by the 09:00 watchdog restart a half hour
#                  later. A console log that erases itself on restart is useless
#                  precisely when you need it, since the thing you want to read
#                  is what happened BEFORE the reboot. append=on fixes that.
#                  (Consequence: nothing rotates this file. It grows ~35KB per
#                  boot, so it is trivial for now, but it is not bounded.)
#
#   SCOPE LIMIT, know this before relying on it: the serial console carries the
#   guest KERNEL and early systemd only, up to the login prompt. It does NOT
#   carry Home Assistant Core's logs , Core runs in a supervisor-managed
#   container and logs to the journal. So this WILL show a kernel panic or a
#   kernel OOM-killer, and will NOT show an application-level Core crash. For
#   the latter you still need in-guest access (see docs/ha-homelab.md).
#   -monitor unix: gives stop-haos.sh an ACPI `system_powerdown` channel, so a
#                  stop is a CLEAN guest shutdown instead of SIGTERM to QEMU.
#                  Unclean shutdowns corrupt HA's recorder DB (a 2026-07-13
#                  incident cost a ~55min rebuild with :8123 shut throughout).
# Both live in /tmp deliberately: they are per-boot debris, not state.
SERIAL_LOG="${HAOS_SERIAL_LOG:-/tmp/haos-serial.log}"
MONITOR_SOCK="${HAOS_MONITOR_SOCK:-/tmp/haos-mon.sock}"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "HAOS already running (PID $(cat "$PIDFILE"))"
  exit 0
fi

# A stale monitor socket from a previous boot makes QEMU fail to bind. Remove it
# only once we know no VM is running (checked immediately above).
rm -f "$MONITOR_SOCK"

# Wait for Wi-Fi (en1) to have an IP. socket_vmnet can't bridge until then.
for _ in $(seq 1 30); do
  ipconfig getifaddr en1 >/dev/null 2>&1 && break
  sleep 2
done
if ! ipconfig getifaddr en1 >/dev/null 2>&1; then
  echo "en1 has no IP after 60s; exiting so launchd retries"
  exit 1
fi

# Wait for socket_vmnet daemon socket
for _ in $(seq 1 30); do
  [ -S "$SOCKET" ] && break
  sleep 2
done
if [ ! -S "$SOCKET" ]; then
  echo "socket_vmnet socket missing after 60s; exiting so launchd retries"
  exit 1
fi

run_qemu() {
  /opt/homebrew/opt/socket_vmnet/bin/socket_vmnet_client \
    "$SOCKET" \
    qemu-system-aarch64 \
    -machine virt,highmem=on \
    -accel hvf \
    -cpu host \
    -smp "$HAOS_SMP" \
    -m "$HAOS_MEM" \
    -drive file="$HAOS_DIR/efi_vars.fd",format=raw,if=pflash \
    -drive file="$HAOS_DIR/haos.qcow2",format=qcow2,if=virtio \
    -device virtio-net-pci,netdev=net0 \
    -netdev socket,id=net0,fd=3 \
    -display none \
    -chardev file,id=haosserial,path="$SERIAL_LOG",append=on \
    -serial chardev:haosserial \
    -monitor unix:"$MONITOR_SOCK",server,nowait \
    -daemonize \
    -pidfile "$PIDFILE" 2>&1
}

OUT=$(run_qemu)
EC=$?

# Self-heal: if socket_vmnet is wedged (vmnet_start_interface failure surfaces
# as "Connection refused" to the client), kick the daemon and retry once.
if [ $EC -ne 0 ] && echo "$OUT" | grep -qi "Connection refused"; then
  echo "socket_vmnet wedged, kicking via sudo..."
  if sudo -n /bin/launchctl kickstart -k "$VMNET_LABEL" 2>/dev/null; then
    for _ in $(seq 1 15); do
      [ -S "$SOCKET" ] && break
      sleep 2
    done
    sleep 2
    rm -f "$MONITOR_SOCK"
    OUT=$(run_qemu)
    EC=$?
  else
    echo "passwordless sudo for socket_vmnet kickstart not configured"
  fi
fi

if [ $EC -eq 0 ] && [ -f "$PIDFILE" ]; then
  echo "HAOS started (PID $(cat "$PIDFILE")) mem=$HAOS_MEM smp=$HAOS_SMP"
  echo "  serial log : $SERIAL_LOG"
  echo "  monitor    : $MONITOR_SOCK"
  exit 0
fi
echo "$OUT"
echo "Failed to start HAOS"
exit 1
