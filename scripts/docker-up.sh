#!/bin/sh

set -eu

# Older Docker/Compose setups on this machine don't have the buildx plugin.
# Force the classic builder so local `up --build` stays warning-free.
export DOCKER_BUILDKIT=0
export COMPOSE_DOCKER_CLI_BUILD=0

exec docker-compose up --build "$@"
