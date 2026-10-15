#!/usr/bin/env bash
# zelto — AI Programming Cockpit
# https://github.com/zelto/zelto

set -e
node "$(dirname "$0")/dist/cli/index.js" "$@"
