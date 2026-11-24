#!/usr/bin/env python3
"""Self-hosted co-op server (lobby + relay) for the Azeroth Survivors client.


The client opens two WebSockets, both answered here:


  /coop/lobby/   the lobby: host a run, join one by code, keep-alive
  /coop/         the relay: carries the players' game frames between host and guests


The wire format was read from a capture of the official service (all frames are binary, little
endian, strings are u32 length + UTF-8):


  lobby, client -> server
    01 proto:u32 version:str zone:str flag:u8            hello
    03 name:str public:u8 password:str description:str hero:str class:u8 zone:str <tail>   host a run
    04 hero:str class:u8 zone:str <tail>                 host changed hero/zone/difficulty
    05 code:str password:str                             join a run
    02                                                   refresh the public list
    09 / 08                                              ping / bye
  lobby, server -> client
    1e relay_url:str ticket                              go to the relay with this ticket
    15 code:str                                          you are hosting this lobby (code)
    16 code:str                                          you joined this lobby (code)  <- NOT 15, or the guest thinks it hosts
    1b text:str                                          the party ended ("the host left")
    21 players:u32 country:str                           lobby status
    18 players:u32                                       somebody joined / left
    14 count:u32 entries                                 public list (answer to 02, empty = 14 00000000)
    17 text:str                                          error (the connection stays open)
    1c                                                   pong
  ticket = code:str lobby_id:u64 role:u32(0 host,1 guest) version:str expires:u64 sig:(u32 len, 64 bytes)


  relay, client -> server
    0b ticket                                            connect
    06 chan:u32 len:u32 payload                          send to a peer
    09 / 08                                              ping / bye
  relay, server -> client
    1a chan:u32 len:u32 payload                          a frame from a peer
    1c                                                   pong


The relay never looks inside a payload. The host is peer 0; guests are peers 1, 2, ...
A host addresses a guest by its number; a guest's frames always go to the host.


Anything this file does not recognise is written to coop_unknown.log (hex) so the format can be
completed from a real session. `--trace` logs every frame in both directions.
"""
import argparse
import asyncio
import hashlib
import hmac
import logging
import os
import secrets
import struct
import sys
import time


import websockets


LOG = logging.getLogger('coop')
VERSION = 'v7 (host relay reconnect grace)'


# no 0/O, 1/I/L, 2/Z, 5/S, 8/B: the game's font makes them easy to misread when a code is typed
CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'
MAX_PLAYERS = 5            # "Party: {n}/5": the host plus four guests
JOIN_TAGS = (0x05,)        # join request: code:str password:str (confirmed from a real join frame)
TICKET_TTL = 3600
# How long a room is kept after the host's relay socket drops. The game recycles that socket
# when it enters a zone and reconnects a moment later with the same ticket, so closing the room
# at once would reject the host's own reconnect ("bad ticket") and end the party.
HOST_RELAY_GRACE = 15.0
# the texts the game understands (read from the client): it shows them as "Could not join: <text>."
ERR_NO_LOBBY = 'no lobby with that code'
ERR_PASSWORD = 'wrong password'
ERR_FULL = 'the party is full'
ERR_STARTED = 'the run is under way'
ERR_IN_LOBBY = 'already in a lobby'
ERR_VERSION = 'a different version of the game'
UNKNOWN_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'coop_unknown.log')




# --------------------------------------------------------------------------- wire helpers


class Reader:
    def __init__(self, data):
        self.d = data
        self.i = 0


    def u8(self):
        v = self.d[self.i]
        self.i += 1
        return v


    def u32(self):
        v = struct.unpack_from('<I', self.d, self.i)[0]
        self.i += 4
        return v


    def u64(self):
        v = struct.unpack_from('<Q', self.d, self.i)[0]
        self.i += 8
        return v


    def raw(self, n):
        if self.i + n > len(self.d):
            raise ValueError('short frame')
        v = self.d[self.i:self.i + n]
        self.i += n
        return v


    def str(self):
        return self.raw(self.u32()).decode('utf-8', 'replace')


    def rest(self):
        v = self.d[self.i:]
        self.i = len(self.d)
        return v




def w_str(s):
    b = s.encode('utf-8')
    return struct.pack('<I', len(b)) + b




def w_u32(v):
    return struct.pack('<I', v)




def w_u64(v):
    return struct.pack('<Q', v)




# --------------------------------------------------------------------------- state


class Room:
    def __init__(self, code, lobby_id, name, public, description, password, hero, hero_class, zone, tail, version, country):
        self.code = code
        self.lobby_id = lobby_id
        self.name = name
        self.public = public
        self.description = description
        self.password = password
        self.hero = hero
        self.hero_class = hero_class
        self.zone = zone
        self.tail = tail
        self.version = version
        self.country = country
        self.lobby_ws = None     # the host's lobby socket
        self.host_ws = None      # the host's relay socket
        self.guests = {}         # peer id -> relay socket
        self.guest_ws = {}       # lobby socket of each joined guest -> its class id (None until it says)
        self.next_peer = 1
        self.host_chan = 0       # the number a guest uses for the host (learned from its first frame)
        self.closed = False
        self.host_grace = None   # pending teardown while the host has no live socket


    @property
    def players(self):
        return 1 + len(self.guests)




class Server:
    def __init__(self, public_url, secret=None, country='XX', trace=False, list_entries=True):
        self.list_entries = list_entries
        self.public_url = public_url.rstrip('/')
        self.secret = secret or secrets.token_bytes(32)
        self.country = country
        self.trace = trace
        self.rooms = {}


    # ---- tickets
    def make_ticket(self, room, role):
        expires = int(time.time()) + TICKET_TTL
        body = (w_str(room.code) + w_u64(room.lobby_id) + w_u32(role) + w_str(room.version)
                + w_u64(expires))
        sig = hmac.new(self.secret, body, hashlib.sha512).digest()  # 64 bytes, like the official signature
        return body + w_u32(len(sig)) + sig


    def read_ticket(self, r):
        start = r.i
        code = r.str()
        lobby_id = r.u64()
        role = r.u32()
        version = r.str()
        expires = r.u64()
        body = r.d[start:r.i]
        sig = r.raw(r.u32())
        good = hmac.compare_digest(sig, hmac.new(self.secret, body, hashlib.sha512).digest())
        return code, lobby_id, role, version, expires, good


    def new_code(self):
        while True:
            code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(5))
            if code not in self.rooms:
                return code


    # ---- logging
    def note_unknown(self, where, data):
        LOG.warning('unknown %s frame (%d bytes): %s', where, len(data), data[:64].hex())
        try:
            with open(UNKNOWN_LOG, 'a') as f:
                f.write('%s %s %s\n' % (time.strftime('%F %T'), where, data.hex()))
        except OSError:
            pass


    def tr(self, who, direction, data):
        if self.trace:
            LOG.info('%s %s %d %s', who, direction, len(data), data[:48].hex())


    async def send(self, ws, who, data):
        self.tr(who, '->', data)
        try:
            await ws.send(data)
        except websockets.ConnectionClosed:
            pass


    # ---- lobby socket
    async def lobby(self, ws):
        mine_host = None      # Room this socket hosts
        mine_guest = None     # Room this socket joined
        try:
            async for msg in ws:
                if isinstance(msg, str):
                    continue
                self.tr('lobby', '<-', msg)
                if not msg:
                    continue
                tag = msg[0]
                try:
                    r = Reader(msg)
                    r.u8()
                    if tag == 0x01:                       # hello
                        r.u32()
                        self.version_seen = r.str()
                        # nothing to answer: with no public lobbies the official lobby sends no list either
                    elif tag == 0x09:
                        await self.send(ws, 'lobby', b'\x1c')
                    elif tag == 0x08:
                        break
                    elif tag == 0x02:                     # refresh the public list (no payload)
                        await self.send(ws, 'lobby', self.list_frame())
                    elif tag == 0x03:                     # host
                        name = r.str()
                        public = r.u8()
                        password = r.str()
                        description = r.str()
                        hero = r.str()
                        hero_class = r.u8()
                        zone = r.str()
                        tail = r.rest()
                        if mine_host:
                            await self.send(ws, 'lobby', b'\x17' + w_str(ERR_IN_LOBBY))
                            continue
                        code = self.new_code()
                        room = Room(code, secrets.randbits(64), name, public, description, password, hero,
                                    hero_class, zone, tail, getattr(self, 'version_seen', '0.145.0'), self.country)
                        room.lobby_ws = ws
                        self.rooms[code] = room
                        mine_host = room
                        LOG.info('room %s hosted: %r (%s, class %d, %s)', code, name, hero, hero_class, zone)
                        await self.send(ws, 'lobby', b'\x1e' + w_str(self.public_url + '/coop/')
                                        + self.make_ticket(room, 0))
                        await self.send(ws, 'lobby', b'\x15' + w_str(code))
                        await self.send(ws, 'lobby', b'\x21' + w_u32(0) + w_str(self.country))
                    elif tag == 0x04 and mine_host:       # host changed hero / zone
                        mine_host.hero = r.str()
                        mine_host.hero_class = r.u8()
                        mine_host.zone = r.str()
                        # (the tail of an update has another layout than the one of a host frame: keep the host's)
                    elif tag == 0x04 and mine_guest:      # a guest says which hero it plays
                        r.str()
                        mine_guest.guest_ws[ws] = r.u8()
                    elif tag == 0x04:
                        LOG.info('hero/zone update from a socket that is not in a lobby: ignored')
                    elif tag in JOIN_TAGS:                # join
                        code = r.str().strip().upper()
                        password = r.str()
                        room = self.rooms.get(code)
                        if not room or room.closed:
                            LOG.info('join %s: no such lobby', code)
                            await self.send(ws, 'lobby', b'\x17' + w_str(ERR_NO_LOBBY))
                        elif room.password and room.password != password:
                            LOG.info('join %s: wrong password', code)
                            await self.send(ws, 'lobby', b'\x17' + w_str(ERR_PASSWORD))
                        elif room.players >= self.max_players(room):
                            await self.send(ws, 'lobby', b'\x17' + w_str(ERR_FULL))
                        else:
                            mine_guest = room
                            room.guest_ws[ws] = None
                            LOG.info('join %s accepted (ticket role 1)', code)
                            await self.send(ws, 'lobby', b'\x1e' + w_str(self.public_url + '/coop/')
                                            + self.make_ticket(room, 1))
                            await self.send(ws, 'lobby', b'\x16' + w_str(code))
                    else:
                        self.note_unknown('lobby', msg)
                except (ValueError, IndexError, struct.error):
                    self.note_unknown('lobby(bad)', msg)
        except websockets.ConnectionClosed:
            pass
        finally:
            if mine_guest:
                mine_guest.guest_ws.pop(ws, None)
            if mine_host:
                # the lobby socket going away does not end the party while the host is on the relay
                self.host_lobby_gone(mine_host)


    async def tell_host_count(self, room):
        if room.lobby_ws:
            n = len(room.guests)
            await self.send(room.lobby_ws, 'lobby', b'\x18' + w_u32(n))
            await self.send(room.lobby_ws, 'lobby', b'\x21' + w_u32(n) + w_str(room.country))


    @staticmethod
    def tail_fields(room):
        """The host frame's tail: open:u8, difficulty:u32, class:u8, max:u16 and (0.145 clients only) one more byte."""
        t = room.tail
        opened = t[0] if len(t) >= 1 else 1
        max_players = struct.unpack_from('<H', t, 6)[0] if len(t) >= 8 else MAX_PLAYERS
        extra = t[8] if len(t) >= 9 else None
        return opened, max_players or MAX_PLAYERS, extra


    @staticmethod
    def host_class(room):
        """The class listed for the host's slot comes from the tail, not from the hero class field."""
        return room.tail[5] if len(room.tail) >= 6 else room.hero_class


    def max_players(self, room):
        return min(self.tail_fields(room)[1], MAX_PLAYERS)


    def list_frame(self):
        """Answer to a list refresh. The official lobby always answers, with 14 00000000 when nothing is listed.
        A lobby is listed when it is public, open, not full and its host is on the relay or still setting up."""
        rooms = []
        if self.list_entries:
            for r in self.rooms.values():
                opened, mx, _ = self.tail_fields(r)
                if r.public and opened == 1 and not r.closed and r.players < min(mx, MAX_PLAYERS):
                    rooms.append(r)
        return b'\x14' + w_u32(len(rooms)) + b''.join(self.list_entry(r) for r in rooms)


    def list_entry(self, r):
        # Layout decoded from nine official entries (0.145.0): code, name, description, hero, class, zone,
        # three flags (open, locked, open), country, classes of the members (u32 count + ids), u32 0 (lacks),
        # max players as u8, one zero byte and, for 0.145 clients, the host frame's last byte.
        opened, mx, extra = self.tail_fields(r)
        classes = bytes([self.host_class(r)] + [c for c in r.guest_ws.values() if c is not None])
        tail = bytes([mx & 0xff, 0]) + (bytes([extra]) if extra is not None else b'')
        return (w_str(r.code) + w_str(r.name) + w_str(r.description) + w_str(r.hero) + bytes([r.hero_class])
                + w_str(r.zone) + bytes([1, 1 if r.password else 0, 1]) + w_str(r.country)
                + w_u32(len(classes)) + classes + w_u32(0) + tail)


    def close_room(self, room):
        if room.closed:
            return
        room.closed = True
        self.rooms.pop(room.code, None)
        LOG.info('room %s closed', room.code)
        for ws in list(room.guest_ws):                 # tell each guest's lobby socket why it is over
            asyncio.ensure_future(self.send(ws, 'lobby', b'\x1b' + w_str('the host left')))
        for ws in list(room.guests.values()):
            asyncio.ensure_future(ws.close(1000, 'the host left'))
        room.guests.clear()


    def host_relay_gone(self, room):
        """The host's relay socket dropped. Keep the room for a moment: the game recycles this
        socket when it enters a zone and reconnects a moment later with the same ticket, so
        closing the room at once would reject the host's own reconnect and end the party."""
        room.host_ws = None
        self.arm_host_grace(room)


    def host_lobby_gone(self, room):
        """The host's lobby socket dropped. That alone does not end the party while the host is
        still on the relay; only a room with no live host socket is torn down."""
        room.lobby_ws = None
        if room.host_ws is None:
            self.arm_host_grace(room)


    def arm_host_grace(self, room):
        if room.closed:
            return
        if room.host_grace and not room.host_grace.done():
            room.host_grace.cancel()


        async def reap():
            try:
                await asyncio.sleep(HOST_RELAY_GRACE)
                if not room.closed and room.host_ws is None:
                    LOG.info('room %s: host did not come back, closing', room.code)
                    self.close_room(room)
            except asyncio.CancelledError:
                pass


        LOG.info('room %s: host socket gone, waiting %.0fs for the host to come back',
                 room.code, HOST_RELAY_GRACE)
        room.host_grace = asyncio.ensure_future(reap())


    def host_back(self, room):
        if room.host_grace and not room.host_grace.done():
            room.host_grace.cancel()
        room.host_grace = None


    # ---- relay socket
    async def relay(self, ws):
        room = None
        peer = None
        try:
            async for msg in ws:
                if isinstance(msg, str):
                    continue
                self.tr('relay', '<-', msg)
                if not msg:
                    continue
                tag = msg[0]
                if tag == 0x09:
                    await self.send(ws, 'relay', b'\x1c')
                    continue
                if tag == 0x08:
                    break
                try:
                    r = Reader(msg)
                    r.u8()
                    if tag == 0x0b and room is None:          # connect with a ticket
                        code, lobby_id, role, version, expires, good = self.read_ticket(r)
                        found = self.rooms.get(code)
                        if not good or not found or found.lobby_id != lobby_id or expires < time.time():
                            LOG.info('relay: bad ticket for %s', code)
                            await ws.close(4001, 'bad ticket')
                            return
                        if role == 0:
                            room, peer = found, 0
                            room.host_ws = ws
                            self.host_back(room)
                            LOG.info('room %s: host on the relay', code)
                        else:
                            if found.players >= self.max_players(found) or not found.host_ws:
                                await ws.close(4009, 'the party is full')
                                return
                            room = found
                            peer = room.next_peer
                            room.next_peer += 1
                            room.guests[peer] = ws
                            LOG.info('room %s: guest %d on the relay (%d players)', code, peer, room.players)
                            await self.tell_host_count(room)
                    elif tag == 0x06 and room is not None:     # frame for a peer
                        chan = r.u32()
                        n = r.u32()
                        payload = r.raw(n)
                        if peer == 0:
                            targets = ([room.guests.get(chan)] if chan in room.guests
                                       else (list(room.guests.values()) if chan == 0 else []))
                            frm = room.host_chan
                        else:
                            room.host_chan = chan
                            targets = [room.host_ws]
                            frm = peer
                        out = b'\x1a' + w_u32(frm) + w_u32(len(payload)) + payload
                        for t in targets:
                            if t is not None:
                                await self.send(t, 'relay', out)
                    else:
                        self.note_unknown('relay', msg)
                except (ValueError, IndexError, struct.error):
                    self.note_unknown('relay(bad)', msg)
        except websockets.ConnectionClosed:
            pass
        finally:
            if room and not room.closed:
                if peer == 0:
                    self.host_relay_gone(room)
                elif room.guests.get(peer) is ws:
                    del room.guests[peer]
                    LOG.info('room %s: guest %d left', room.code, peer)
                    await self.tell_host_count(room)


    # ---- entry
    async def handler(self, ws):
        path = getattr(getattr(ws, 'request', None), 'path', None) or getattr(ws, 'path', '')
        path = path.split('?', 1)[0]
        if path.rstrip('/') == '/coop/lobby':
            await self.lobby(ws)
        elif path.rstrip('/') == '/coop':
            await self.relay(ws)
        else:
            await ws.close(4404, 'unknown path')




async def serve(host='127.0.0.1', port=8765, public_url=None, country='XX', trace=False, list_entries=True):
    public_url = public_url or 'ws://%s:%d' % ('127.0.0.1' if host in ('0.0.0.0', '::') else host, port)
    server = Server(public_url, country=country, trace=trace, list_entries=list_entries)
    async with websockets.serve(server.handler, host, port, max_size=1 << 20, ping_interval=None):
        LOG.info('co-op server %s on ws://%s:%d (lobby /coop/lobby/, relay /coop/)', VERSION, host, port)
        await asyncio.Future()




def serve_in_thread(host='127.0.0.1', port=8765, **kw):
    """Run the server on its own event loop, for serve.py to start next to the HTTP server."""
    import threading


    def run():
        try:
            asyncio.run(serve(host, port, **kw))
        except OSError as e:
            LOG.error('co-op server could not start on %s:%d: %s', host, port, e)


    t = threading.Thread(target=run, name='coop', daemon=True)
    t.start()
    return t




def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--host', default='127.0.0.1', help='address to listen on (0.0.0.0 to let friends in)')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--public-url', default=None,
                    help='ws:// or wss:// address players reach this server at, if not host:port')
    ap.add_argument('--country', default='XX', help='two-letter country shown for hosted lobbies')
    ap.add_argument('--no-list-entries', action='store_true', help='always answer the lobby list with an empty list')
    ap.add_argument('--trace', action='store_true', help='log every frame (send this when reporting a problem)')
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s', stream=sys.stderr)
    try:
        asyncio.run(serve(a.host, a.port, a.public_url, a.country, a.trace, not a.no_list_entries))
    except KeyboardInterrupt:
        pass




if __name__ == '__main__':
    main()