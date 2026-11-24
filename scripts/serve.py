#!/usr/bin/env python3
"""Local static file server for the Azeroth Survivors reconstruction.


Serves the public/ directory tree with the same layout as wow.aethus.pl:
  /                      -> index.html
  /rogue.js, /rogue.css, /wasi_stubs.js, /boot.js, /addons.js,
  /saves.js, /ime.js     -> launcher modules
  /boot-manifest.json, /world-manifest.json
  /data/__index          -> the game's name index
  /download/...          -> the Windows build (not redistributed here)


It also proxies the co-op WebSocket endpoints (/coop/lobby/ and /coop/) to the
co-op server that runs next to it, so the client can reach both from one origin.
"""
import argparse
import http.server
import os
import select
import socket
import sys
import json
from urllib.parse import unquote


PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
CONFIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'benilla-config')

# The co-op server's own port; WebSocket upgrades under /coop/ are tunnelled here.
COOP_PORT = 8765


MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
}


# Routes that the real site answers with a redirect. A browser/IDM follows these before the
# final destination, so they must be here too (the real site redirects /download -> the .rar).
DOWNLOAD_NAME = 'AzerothSurvivorsWindowsNew.rar'




def resolve_case_insensitive(root, relative):
    """Resolve a relative path, ignoring filename and directory case."""
    root = os.path.abspath(root)
    current = root


    for part in relative.replace("\\\\", "/").split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            return None


        try:
            entries = os.listdir(current)
        except OSError:
            return None


        if part in entries:
            match = part
        else:
            matches = [entry for entry in entries
                       if entry.casefold() == part.casefold()]
            if not matches:
                return None
            match = matches[0]


        current = os.path.join(current, match)


    if os.path.commonpath([root, os.path.abspath(current)]) != root:
        return None


    return current




class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=PUBLIC_DIR, **kw)


    def _send(self, path, status=200, ctype='text/html; charset=utf-8', extra=None):
        body = b''
        if path and os.path.isfile(path):
            with open(path, 'rb') as f:
                body = f.read()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)


    def _redirect(self, location, status=302):
        self.send_response(status)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.end_headers()


    def _proxy_to_coop(self):
        """Tunnel a WebSocket upgrade to the co-op server on its own port.

        The client opens /coop/lobby/ and /coop/ on this server's origin, so the
        upgrade has to be handed to the co-op server rather than answered here.
        """
        try:
            upstream = socket.create_connection(('127.0.0.1', COOP_PORT), timeout=10)
        except OSError:
            return self._send(None, status=502, ctype='text/plain; charset=utf-8')


        head = ['%s %s %s' % (self.command, self.path, self.request_version)]
        head += ['%s: %s' % (k, v) for k, v in self.headers.items()]
        head += ['', '']
        try:
            upstream.sendall('\r\n'.join(head).encode('latin-1'))
        except OSError:
            upstream.close()
            return self._send(None, status=502, ctype='text/plain; charset=utf-8')


        self.close_connection = True
        client = self.connection
        try:
            while True:
                # A quiet socket is normal (the client sends no keep-alive frames), so a
                # timeout just means "nothing to move", not "hang up". A closed peer still
                # shows up as readable with a zero-byte recv below.
                readable, _, _ = select.select([client, upstream], [], [], 30)
                for src in readable:
                    dst = upstream if src is client else client
                    chunk = src.recv(65536)
                    if not chunk:
                        return
                    dst.sendall(chunk)
        except OSError:
            pass
        finally:
            try:
                upstream.close()
            except OSError:
                pass


    def do_GET(self):
        # Normalize path
        raw = unquote(self.path.split('?', 1)[0])
        rel = raw.lstrip('/')


        # /coop/lobby/ and /coop/ are WebSockets answered by the co-op server. Tunnel the
        # upgrade to it; a plain GET there is a mistake, so say what is expected.
        if rel == 'coop' or rel.startswith('coop/'):
            if 'websocket' in self.headers.get('Upgrade', '').lower():
                return self._proxy_to_coop()
            return self._send(None, status=426, ctype='text/plain; charset=utf-8',
                              extra={'Upgrade': 'websocket'})


        if raw in ('', '/'):
            return self._send(os.path.join(PUBLIC_DIR, 'index.html'))


        # /download and /download/ -> redirect to the Windows build, as the real site does.
        # The build itself is not redistributed in this reconstruction, so the target 404s.
        if rel in ('download', 'download/'):
            return self._redirect('/download/' + DOWNLOAD_NAME)


        # /discord -> Discord invite, as the real site does.
        if rel == 'discord':
            return self._redirect('nope')


        # /support and /support/ -> the "Buy me a coffee" button. Redirect to donofa.com.
        if self.path.strip('/') in ('support', 'support/'):
            self.send_response(302)
            self.send_header('Location', 'https://donofa.com/noone')
            self.end_headers()
            return


        # /data -> redirect to /data/, as the real site does (301).
        if rel == 'data':
            return self._redirect('/data/', status=301)


        # /data/ -> the real site answers 403 (a directory listing is not exposed).
        if rel == 'data/':
            return self._send(None, status=403, ctype='text/plain; charset=utf-8')


        # /download/<name> -> the Windows build. Not redistributed here: answer 404 with no
        # download-triggering headers (no application/x-rar-compressed, no Content-Disposition:
        # attachment, no body). The link stays clickable and no popup appears.
        if rel.lower().startswith('download/'):
            return self._send(None, status=404, ctype='text/plain; charset=utf-8')


        # /data/* -> data dir (the game's name index and every asset). Served immutable, like the
        # real site, so the boot prefetch and the client's own sync reads hit the HTTP cache.
        if rel.lower().startswith('data/'):
            fname = rel[5:]
            local = resolve_case_insensitive(DATA_DIR, fname)
            if local and os.path.isfile(local):
                return self._send(local, ctype='application/octet-stream',
                                  extra={'Cache-Control': 'max-age=31536000, immutable'})
            return self._send(local, status=404, ctype='text/plain; charset=utf-8')


        # Static files under public/
        local = resolve_case_insensitive(PUBLIC_DIR, rel)
        if local and os.path.isfile(local):
            ext = os.path.splitext(local)[1].lower()
            ctype = MIME.get(ext, 'application/octet-stream')
            return self._send(local, ctype=ctype,
                              extra={'Cache-Control': 'max-age=3600'} if ext in ('.js', '.css') else None)
        return self._send(local, status=404, ctype='text/plain; charset=utf-8')


    def log_message(self, fmt, *args):
        sys.stderr.write('[server] ' + (fmt % args) + '\n')




def main():
    parser = argparse.ArgumentParser(
        description='Local static file server for the Azeroth Survivors reconstruction.'
    )
    parser.add_argument('port', nargs='?', type=int, default=8000,
                        help='port to listen on (default: 8000)')
    parser.add_argument('--public', default=None,
                        help='override the public/ directory (bundled path in the launcher)')
    parser.add_argument('--data', default=None,
                        help='override the data/ directory (bundled path in the launcher)')
    parser.add_argument('--config', default=None,
                        help='override the benilla-config/ directory (bundled path in the launcher)')
    parser.add_argument('--coop-port', type=int, default=8765,
                        help='port of the co-op server started next to the web server (default: 8765)')
    parser.add_argument('--coop-host', default='127.0.0.1',
                        help='address the co-op server listens on; 0.0.0.0 lets friends connect')
    parser.add_argument('--coop-public-url', default=None,
                        help='ws:// or wss:// address friends reach the co-op server at')
    parser.add_argument('--coop-trace', action='store_true',
                        help='log every co-op frame (send this when reporting a co-op problem)')
    parser.add_argument('--no-coop', action='store_true', help='do not start the co-op server')
    args = parser.parse_args()


    global PUBLIC_DIR, DATA_DIR, CONFIG_DIR, COOP_PORT
    if args.public:
        PUBLIC_DIR = args.public
    if args.data:
        DATA_DIR = args.data
    if args.config:
        CONFIG_DIR = args.config
    COOP_PORT = args.coop_port


    if not args.no_coop:
        try:
            import logging
            logging.basicConfig(level=logging.INFO, format='[coop] %(message)s', stream=sys.stderr)
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import coop_server
            # Advertise the relay on this server's own origin: the client reaches it through the
            # /coop/ tunnel above, so one address works for both the page and the sockets.
            coop_server.serve_in_thread(args.coop_host, args.coop_port,
                                        public_url=args.coop_public_url or 'ws://127.0.0.1:%d' % args.port,
                                        trace=args.coop_trace)
            print(f'  co-op  : ws://{args.coop_host}:{args.coop_port} (proxied at /coop/)')
        except ImportError as e:
            print(f'  co-op  : not started ({e}); run: pip install websockets')


    # Threading matters: an open WebSocket tunnel occupies a handler thread for the whole
    # session, so a single-threaded server would stop serving the game's assets.
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Azeroth Survivors reconstruction serving on http://127.0.0.1:{args.port}')
    print(f'  public : {PUBLIC_DIR}')
    print(f'  data   : {DATA_DIR}')
    print(f'  config : {CONFIG_DIR}')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass




if __name__ == '__main__':
    main()
