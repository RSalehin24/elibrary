#!/bin/bash
set -euo pipefail

TARGET="/usr/local/bin/dockerctl"
SOURCE="$HOME/Documents/ebook-scrapping/local/scripts/dockerctl"

# Check if dockerctl exists
if [ ! -f "$TARGET" ]; then
  echo "dockerctl not found in /usr/local/bin. Installing..."

  if [ ! -f "$SOURCE" ]; then
    echo "Error: source dockerctl not found at $SOURCE"
    exit 1
  fi

  sudo cp "$SOURCE" "$TARGET"
  sudo chmod +x "$TARGET"

  echo "dockerctl installed to $TARGET"
else
  echo "dockerctl already installed."
fi

# Start Docker
dockerctl start

# Run your dev script
bash "$HOME/Documents/ebook-scrapping/local/scripts/dev.sh" up
