#!/bin/bash
# Stops the Home Assistant OS QEMU guest CLEANLY.
#
# SOURCE OF TRUTH: this file. It is installed to ~/homeassistant-os/stop-haos.sh
# by scripts/install-haos.sh; never hand-edit the copy on the box.
#
# WHY THIS EXISTS (2026-07-24): the previous version was a bare
#   kill "$(cat "$PIDFILE")"
# i.e. SIGTERM to the QEMU *process*. The guest was never told to shut down, so
# every "clean restart" was in fact a power-cut to Home Assistant. That is what
# corrupted the recorder DB on 2026-07-13 and cost a ~55min rebuild with :8123
# shut the whole time. docs/ha-homelab.md used to call this the clean path; it
# was wrong.
#
# The correct path is ACPI: `system_powerdown` over QEMU's monitor socket, which
# the guest kernel handles as a real shutdown request. SIGTERM and SIGKILL remain
# ONLY as escalating fallbacks, and each one is announced loudly so an unclean
# stop can never happen silently.
#
# Degrades gracefully when the monitor socket is absent — a VM started by the old
# pre-2026-07-24 start-haos.sh has none, and there is nothing to be done for it
# but the fallback. Once such a VM has been cycled once, every later stop is clean.

set -uo pipefail # NOT -e: probing a dying process is expected control flow.

HAOS_DIR="$HOME/homeassistant-os"
PIDFILE="${HAOS_PIDFILE:-$HAOS_DIR/haos.pid}"
MONITOR_SOCK="${HAOS_MONITOR_SOCK:-/tmp/haos-mon.sock}"
# 180s, raised from 60s after the first real trial (2026-07-24 09:00, triggered by
# the HA watchdog) timed out and fell back to SIGTERM. A full HA shutdown stops
# Core, then the add-ons, then the supervisor, and flushes the recorder , that
# routinely exceeds 60s, so 60 was simply too aggressive.
#
# UNPROVEN, BE HONEST: it is NOT yet established that HAOS responds to the ACPI
# power button at all. What IS established is that the transport works , sending
# `info status` over the same monitor socket returns "VM status: running", so
# `system_powerdown` definitely reached QEMU and the guest did not act on it in
# 60s. If 180s also falls back, the guest is ignoring ACPI and the real fix is a
# guest-side `ha host shutdown` (needs the SSH add-on or :22222 access), not a
# longer timeout here.
ACPI_WAIT="${HAOS_ACPI_WAIT:-180}" # seconds to allow a graceful guest shutdown
TERM_WAIT="${HAOS_TERM_WAIT:-15}"  # seconds to allow SIGTERM to land

if [ ! -f "$PIDFILE" ]; then
  echo "No PID file found ($PIDFILE); nothing to stop"
  exit 0
fi

PID="$(cat "$PIDFILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID not running; removing stale pidfile"
  rm -f "$PIDFILE"
  exit 0
fi

# Waits up to $1 seconds for $PID to exit. Returns 0 if it exited.
wait_for_exit() {
  local limit="$1" waited=0
  while [ "$waited" -lt "$limit" ]; do
    kill -0 "$PID" 2>/dev/null || return 0
    sleep 1
    waited=$((waited + 1))
  done
  ! kill -0 "$PID" 2>/dev/null
}

finish() {
  rm -f "$PIDFILE" "$MONITOR_SOCK"
  echo "HAOS stopped (PID $PID)"
  exit 0
}

# --- 1. ACPI powerdown (the clean path) --------------------------------------
if [ -S "$MONITOR_SOCK" ]; then
  echo "sending ACPI system_powerdown via $MONITOR_SOCK ..."
  printf 'system_powerdown\n' | nc -U -w 2 "$MONITOR_SOCK" >/dev/null 2>&1
  if wait_for_exit "$ACPI_WAIT"; then
    echo "guest shut down cleanly"
    finish
  fi
  echo "WARNING: guest did not exit within ${ACPI_WAIT}s of ACPI powerdown"
else
  echo "WARNING: no monitor socket at $MONITOR_SOCK — cannot request a clean"
  echo "         guest shutdown. This VM predates the monitor-socket change;"
  echo "         this stop will be UNCLEAN and may trigger a recorder rebuild."
fi

# --- 2. SIGTERM fallback ------------------------------------------------------
echo "FALLBACK: sending SIGTERM to QEMU (PID $PID) — this is an unclean guest stop"
kill "$PID" 2>/dev/null
if wait_for_exit "$TERM_WAIT"; then
  finish
fi

# --- 3. SIGKILL, last resort --------------------------------------------------
echo "FALLBACK: SIGTERM did not work; sending SIGKILL to PID $PID"
kill -9 "$PID" 2>/dev/null
if wait_for_exit 10; then
  finish
fi

echo "ERROR: PID $PID still alive after SIGKILL; leaving pidfile in place" >&2
exit 1
