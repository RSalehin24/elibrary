#!/bin/bash
set -euo pipefail

bash "$HOME/Documents/ebook-scrapping/local/scripts/ensure-dockerctl.sh" &&
dockerctl start &&
bash "$HOME/Documents/ebook-scrapping/local/scripts/dev.sh" up
