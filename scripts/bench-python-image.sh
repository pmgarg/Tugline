#!/usr/bin/env bash
# Build a SWE-bench base image with pytest preinstalled, for `tug bench swe-bench --image <tag>`.
#
#   scripts/bench-python-image.sh [tag]          (default tag: tugline/bench-python:3.12)
#
# The default swe-bench image (python:3.12-slim) installs pytest with pip inside each task
# container. Where containers cannot reach PyPI (an egress proxy on the host's loopback, an
# offline machine), use this instead: the wheels are downloaded on the host, which may have a
# proxy, and installed in the build with --no-index, so the build itself needs no network.
# BASE=<image> changes the base image (it must have python3 and pip).
set -euo pipefail
tag=${1:-tugline/bench-python:3.12}
base=${BASE:-python:3.12-slim}
pyver=$(docker run --rm --entrypoint python3 "$base" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
python3 -m pip download -q --dest "$ctx/wheels" --only-binary=:all: --python-version "$pyver" --platform any --implementation py pytest
cat > "$ctx/Dockerfile" <<DOCKERFILE
FROM $base
COPY wheels /tmp/wheels
RUN python3 -m pip install -q --no-index --find-links /tmp/wheels pytest && rm -rf /tmp/wheels
DOCKERFILE
docker build -q -t "$tag" "$ctx" >/dev/null
docker run --rm --entrypoint python3 "$tag" -m pytest --version
echo "built $tag"
