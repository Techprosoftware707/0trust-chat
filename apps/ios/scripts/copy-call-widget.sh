#!/bin/sh
# Xcode build phase (Lumen target, after "Copy Bundle Resources"): bundles the
# Lumen call widget built from services/chat (`npm run build:widget` ->
# services/chat/dist-widget/) into the app as CallWidget/, served at
# lumen-widget://call/ by WidgetSchemeHandler.
#
# If the widget hasn't been built, the app is still valid: it then loads the
# operator's copy from `call_widget_url` and says so in Settings > About.
set -eu

SRC="${SRCROOT}/../../services/chat/dist-widget"
DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/CallWidget"

rm -rf "$DEST"
if [ -f "$SRC/index.html" ]; then
  mkdir -p "$DEST"
  # Copy without source maps; never follow symlinks out of the widget folder.
  (cd "$SRC" && find . -type f ! -name '*.map' -print) | while IFS= read -r f; do
    mkdir -p "$DEST/$(dirname "$f")"
    cp "$SRC/$f" "$DEST/$f"
  done
  echo "Bundled call widget from $SRC ($(find "$DEST" -type f | wc -l | tr -d ' ') files)"
else
  echo "warning: services/chat/dist-widget/index.html not found; this build has no bundled call widget and will use the server's call_widget_url."
fi
