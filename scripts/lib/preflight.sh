# Shared checks for the device and live scripts (source it from the repo root).
# oh_preflight_deps: node_modules must be installed for THIS machine (native esbuild, used by tsx).
oh_preflight_deps() {
  if [ ! -d node_modules ]; then
    echo "node_modules is missing. Run:  npm ci" >&2; return 1
  fi
  local err
  if ! err=$(node -e "require('esbuild').transformSync('let a: number = 1', { loader: 'ts' })" 2>&1); then
    if printf '%s' "$err" | grep -q 'another platform'; then
      echo "node_modules was installed on another platform (e.g. Linux). On this machine run:" >&2
      echo "    rm -rf node_modules && npm ci" >&2
    else
      echo "the TypeScript loader does not work here:" >&2; printf '%s\n' "$err" | head -5 >&2
      echo "Try:  rm -rf node_modules && npm ci" >&2
    fi
    return 1
  fi
}
