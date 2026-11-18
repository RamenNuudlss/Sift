#!/usr/bin/env bash
# Builds the Chrome Web Store package: dist/sift-<version>.zip
set -euo pipefail
cd "$(dirname "$0")"
version=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
mkdir -p dist
rm -f "dist/sift-$version.zip"
zip -rq "dist/sift-$version.zip" manifest.json background.js content.js content.css page.js \
  shared.js geo.js popup.html popup.css popup.js icons fonts
echo "Built dist/sift-$version.zip"
