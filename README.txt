Azeroth Survivors - offline bundle
==================================
Needs: python3 (3.8+) and a reverse proxy (Caddy or nginx). Nothing else.

  1. install the one dependency
       sh offline/install.sh

  2. web server (port 8000)
       offline/venv/bin/python game/scripts/serve.py 8000 --no-coop

  3. co-op relay (port 8765)
       offline/venv/bin/python game/scripts/coop_server.py --host 127.0.0.1 --port 8765
