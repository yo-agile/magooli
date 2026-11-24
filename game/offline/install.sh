#!/bin/sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
python3 -m venv "$HERE/venv"
"$HERE/venv/bin/pip" install --no-index --find-links "$HERE/wheels" websockets
echo "offline install done: $HERE/venv"
