#!/usr/bin/env bash
set -euo pipefail

manifest="${1:?usage: software-factory-release-manifest.sh MANIFEST}"

jq --exit-status --compact-output '
  if (.version | test("^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")) and
    (.commit | test("^[0-9a-f]{40}$")) and
    .platform == "linux/amd64" and
    ([.images[].name] | sort) ==
    ["api", "blobs", "codec", "console", "relay", "run-worker", "worker"] and
    all(.images[];
      .image == ("ghcr.io/0x63616c/software-factory-" + .name) and
      (.digest | test("^sha256:[0-9a-f]{64}$")))
  then
    reduce .images[] as $image
      ({}; . + {("software-factory-" + $image.name): $image.digest}) |
    to_entries | sort_by(.key) | from_entries
  else
    error("invalid Software Factory release manifest")
  end
' "$manifest"
