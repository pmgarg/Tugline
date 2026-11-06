#!/usr/bin/env bash
# [DEVICE] N34 external members on macOS (review F4) and the verifier's Seatbelt command tool (review F21).
# Run on the Mac from the repo root:  scripts/device-checks/teams-external-macos.sh   (expected: only PASS lines)
set -euo pipefail
cd "$(dirname "$0")/../.."
node --import tsx scripts/device-checks/teams-external-macos.mts
node --import tsx scripts/device-checks/verifier-macos.mts
