#!/usr/bin/env bash
#
# Downloads a YouTube playlist to the Homelab NAS `youtube/` share, one
# channel-per-folder, for the Plex "YouTube" library to pick up.
#
# Run locally (not on home-server -- YouTube rate-limits/blocks the cluster's
# egress IP, see docs/beads-archive for the parked youtube_ingest job this
# script stands in for):
#
#   ./scripts/youtube-playlist-download.sh <playlist-url>
#
# Requires: yt-dlp, ffmpeg, Chrome signed into a YouTube account (cookies are
# read from it directly via --cookies-from-browser -- close Chrome first, its
# cookie DB locks while running), and /Volumes/Homelab mounted.
#
# Safe to re-run and to Ctrl-C: --download-archive skips ids already written,
# so an interrupted or rate-limited run just resumes from where it stopped.

set -euo pipefail

PLAYLIST_URL="${1:?usage: youtube-playlist-download.sh <playlist-url>}"

NAS_MEDIA_DIR="/Volumes/Homelab/media/youtube"
ARCHIVE_FILE="$HOME/.yt-dlp-archive.txt"
TEMP_DIR="$HOME/.yt-dlp-tmp"

if [[ ! -d "$NAS_MEDIA_DIR" ]]; then
  echo "error: $NAS_MEDIA_DIR not found -- is the Homelab NAS share mounted?" >&2
  exit 1
fi

mkdir -p "$TEMP_DIR"

# -N 1 (no concurrent fragment writes) + generous retries: macOS's SMB client
# has dropped the write fd mid-transfer on large (multi-GB) files under -N 4,
# throwing "Errno 9 Bad file descriptor". Downloading/merging into a local
# temp dir and only touching the NAS for the final move (-P temp:/-P home:)
# avoids the SMB mount for the risky part of the process entirely.
caffeinate -i yt-dlp \
  --cookies-from-browser chrome \
  --download-archive "$ARCHIVE_FILE" \
  --sleep-requests 1.5 --sleep-interval 5 --max-sleep-interval 15 \
  --retries 10 --fragment-retries 10 --retry-sleep 5 \
  -f "bv*[height<=2160]+ba/b[height<=2160]" -S "res,vcodec:av01" -N 1 \
  --write-thumbnail \
  -P "temp:$TEMP_DIR" -P "home:$NAS_MEDIA_DIR" \
  -o "%(uploader)s/%(title)s.%(ext)s" \
  -v \
  "$PLAYLIST_URL"
