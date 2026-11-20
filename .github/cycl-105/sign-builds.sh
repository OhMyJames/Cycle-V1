#!/bin/bash
# Run in the Mac owner's unlocked desktop terminal. The optional argument is a notarytool profile name.
set -euo pipefail
cd "$(dirname "$0")"
export APPLE_NOTARY_PROFILE="${1:-cycle-notary}"
export CYCLE_ANALYTICS=off
xcrun notarytool history --keychain-profile "$APPLE_NOTARY_PROFILE" --output-format json >/dev/null
for version in 0.3.6 0.3.7; do
  desktop="$PWD/$version/apps/desktop"
  app="$desktop/build/Cycle.app"
  if ! xcrun stapler validate "$app" >/dev/null 2>&1; then
    ./bun run --cwd "$desktop" sign
  fi
  codesign --verify --deep --strict "$app"
  spctl --assess --type execute "$app"
  xcrun stapler validate "$app"
  ./bun run --cwd "$desktop" release-assets
  echo "Ready: $desktop/build/release"
done
