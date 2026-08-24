#!/usr/bin/env bash
# Rebuild the extension icons from the app's own logo.
#
# The icons are the same mark the web app uses (frontend/public/favicon.svg),
# rasterised — Chrome will not take an SVG for an extension icon. Regenerate
# after changing the logo rather than editing the PNGs.
#
# Chrome's *new* headless is required: the old one renders a standalone SVG
# zoomed into its top-left corner, which silently produces an icon that is a
# corner of the tile and nothing else. The SVG is also wrapped in a page with
# explicit pixel dimensions, because sizing it in viewport units hits the same
# bug.
set -euo pipefail

cd "$(dirname "$0")/.."
LOGO="../frontend/public/favicon.svg"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "Chrome not found at: $CHROME (set CHROME=...)" >&2; exit 1; }
[ -f "$LOGO" ]   || { echo "logo not found at: $LOGO" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for size in 16 32 48 128; do
  {
    printf '<!doctype html><meta charset="utf-8">\n'
    printf '<style>html,body{margin:0;padding:0;background:transparent;width:%spx;height:%spx;overflow:hidden}\n' "$size" "$size"
    printf 'svg{display:block;width:%spx;height:%spx}</style>\n' "$size" "$size"
    cat "$LOGO"
  } > "$work/w$size.html"

  "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --screenshot="icon$size.png" --window-size="$size,$size" \
    "file://$work/w$size.html" >/dev/null 2>&1
  echo "wrote icon$size.png"
done
