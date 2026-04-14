#!/bin/bash
set -euo pipefail

TARGET="/usr/local/bin/dockerctl"
SOURCE="$HOME/Documents/ebook-scrapping/local/scripts/dockerctl"

if [ ! -f "$SOURCE" ]; then
  echo "Error: source dockerctl not found at $SOURCE"
  exit 1
fi

if [ ! -f "$TARGET" ] || ! cmp -s "$SOURCE" "$TARGET"; then
  echo "Installing/updating dockerctl..."
  sudo cp "$SOURCE" "$TARGET"
  sudo chmod +x "$TARGET"
  echo "dockerctl is ready at $TARGET"
fi
