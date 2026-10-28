#!/bin/zsh
set -eu
FOLIO_DIRECTORY="$(cd -- "$(dirname -- "$0")" && pwd)"
cd -- "$FOLIO_DIRECTORY"
if command -v python3 >/dev/null 2>&1; then
    exec python3 "$FOLIO_DIRECTORY/server.py"
fi
printf '%s\n' 'Python 3 is needed to start Folio locally.'
read -r '?Press Return to close this window.'
