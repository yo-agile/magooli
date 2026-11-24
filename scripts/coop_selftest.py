#!/usr/bin/env python3
"""Replays the frames of a real captured host session against coop_server.py and checks the answers."""
import asyncio, struct, sys, os, logging
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import websockets, coop_server as cs

HELLO = bytes.fromhex('010300000007000000302e3134352e300000000001')
HOST = bytes.fromhex('03090000006c65747320676f6f6f0102000000676700000000050000004167696c650206000000656c77796e6e010100000002020000')
UPDATE = bytes.fromhex('04050000004167696c650206000000656c77796e6e01020000000201020000')
CAPTURED_FRAMES = [  # host -> guest frames from the capture (payloads must pass through untouched)
    '06010000000b0000000001000000000000000202',
    '010000000900000005886f980b00000000',
]

def join_frame(code, pw='gg'):   # HOST below was captured with the text 'gg' in the password field
    return b'\x05' + cs.w_str(code) + cs.w_str(pw)

async def run(port):
    base = 'ws://127.0.0.1:%d' % port
    ok = True
    def check(cond, what):
        nonlocal ok
        print(('PASS ' if cond else 'FAIL ') + what)
        ok &= bool(cond)

    # host
    lob = await websockets.connect(base + '/coop/lobby/')
    await lob.send(HELLO); await lob.send(b'\x09')
    check(await lob.recv() == b'\x1c', 'lobby pong')
    await lob.send(HOST)
    f1, f2, f3 = await lob.recv(), await lob.recv(), await lob.recv()
    check(f1[0] == 0x1e and f2[0] == 0x15 and f3[0] == 0x21, 'host answered 1e,15,21')
    r = cs.Reader(f1); r.u8(); url = r.str()
    ticket_host = f1[1 + 4 + len(url.encode()):]
    code = cs.Reader(f2[1:]).str()
    check(len(code) == 5 and not set(code) & set('0O1IL2Z5S8B'), 'code is 5 chars: ' + code)
    check(len(ticket_host) == 109 - 1, 'ticket is 108 bytes like the official one (got %d)' % len(ticket_host))
    await lob.send(UPDATE)
    rel = await websockets.connect(base + '/coop/')
    await rel.send(b'\x0b' + ticket_host)
    await rel.send(b'\x09')
    check(await rel.recv() == b'\x1c', 'relay pong')

    # guest joins by code
    glob = await websockets.connect(base + '/coop/lobby/')
    await glob.send(HELLO)
    await glob.send(join_frame(code, 'nope'))
    check(await glob.recv() == b'\x17' + cs.w_str('wrong password'), 'wrong password answered with 17 text')
    await glob.send(b'\x02')
    lst = await glob.recv()
    check(lst[:5] == b'\x14\x01\x00\x00\x00', 'list refresh answered 14 with the host\'s public lobby (1 entry)')
    await glob.send(join_frame(code))
    g1, g2 = await glob.recv(), await glob.recv()
    check(g1[0] == 0x1e and g2 == b'\x16' + cs.w_str(code), 'guest answered 1e then 16 <code> (not 15)')
    ticket_guest = g1[1 + 4 + len(url.encode()):]
    check(len(ticket_guest) == len(ticket_host), 'guest ticket same size')
    grel = await websockets.connect(base + '/coop/')
    await grel.send(b'\x0b' + ticket_guest)
    h1, h2 = await lob.recv(), await lob.recv()
    check(h1 == b'\x18' + struct.pack('<I', 1) and h2[0] == 0x21 and struct.unpack('<I', h2[1:5])[0] == 1,
          'host told one guest joined (18 01000000, 21 01000000 ..)')

    # guest -> host (any chan), host -> guest chan 1
    payload = bytes.fromhex('00010000000000000002' '02')
    await grel.send(b'\x06' + struct.pack('<II', 0, len(payload)) + payload)
    got = await asyncio.wait_for(rel.recv(), 3)
    check(got == b'\x1a' + struct.pack('<II', 1, len(payload)) + payload, 'guest frame reaches host as peer 1')
    await rel.send(bytes.fromhex(CAPTURED_FRAMES[0]))
    got = await asyncio.wait_for(grel.recv(), 3)
    check(got[0] == 0x1a and got[9:] == bytes.fromhex(CAPTURED_FRAMES[0])[9:], 'host frame (captured bytes) reaches guest intact')

    # bad ticket, unknown code, wrong password
    bad = await websockets.connect(base + '/coop/')
    await bad.send(b'\x0b' + ticket_host[:-1] + bytes([ticket_host[-1] ^ 1]))
    try:
        await asyncio.wait_for(bad.recv(), 3); check(False, 'forged ticket refused')
    except websockets.ConnectionClosed as e:
        check(e.rcvd and e.rcvd.code == 4001, 'forged ticket refused')
    nl = await websockets.connect(base + '/coop/lobby/')
    await nl.send(join_frame('ZZZZZ'))
    check(await asyncio.wait_for(nl.recv(), 3) == b'\x17' + cs.w_str('no lobby with that code'), 'unknown code answered with 17 text')

    # guest leaves -> host told; host leaves -> guests dropped
    await grel.close()
    h1 = await asyncio.wait_for(lob.recv(), 3)
    check(h1 == b'\x18' + struct.pack('<I', 0), 'host told guest left')
    g2rel = await websockets.connect(base + '/coop/')
    await g2rel.send(b'\x0b' + ticket_guest)
    await asyncio.sleep(0.2)
    await rel.close()
    check(await asyncio.wait_for(glob.recv(), 3) == b'\x1b' + cs.w_str('the host left'), 'guest told 1b "the host left"')
    try:
        await asyncio.wait_for(g2rel.recv(), 3); check(False, 'guests dropped when host leaves')
    except websockets.ConnectionClosed:
        check(True, 'guests dropped when host leaves')
    return ok


async def official_entries(port):
    """Nine real entries recorded from the official lobby (probe 3); mine must be byte-identical."""
    base = 'probe-base'
    def host(name, pw='', desc='d0', cls=2, zone='elwynn', tail='010100000002020000'):
        return (b'\x03' + cs.w_str(name) + b'\x01' + cs.w_str(pw) + cs.w_str(desc) + cs.w_str('Probe') + bytes([cls])
                + cs.w_str(zone) + bytes.fromhex(tail))
    def entry(code, name, cls, zone, flags, country_tail):
        return (b'\x14' + cs.w_u32(1) + cs.w_str(code) + cs.w_str(name) + cs.w_str('d0') + cs.w_str('Probe') + bytes([cls])
                + cs.w_str(zone) + bytes.fromhex(flags) + bytes.fromhex(country_tail))
    IR = '0200000049520100000002' + '00000000' + '020000'
    cases = [
        ('base', host(base), 'probe-base', 2, 'elwynn', '010001', IR),
        ('class5', host('probe-class5', cls=5), 'probe-class5', 5, 'elwynn', '010001', IR),
        ('zone', host('probe-zone-durotar', zone='durotar'), 'probe-zone-durotar', 2, 'durotar', '010001', IR),
        ('tailC=5', host('probe-tailC=5', tail='010100000005020000'), 'probe-tailC=5', 2, 'elwynn', '010001',
         '0200000049520100000005' + '00000000' + '020000'),
        ('tailD=4', host('probe-tailD=4', tail='010100000002040000'), 'probe-tailD=4', 2, 'elwynn', '010001',
         '0200000049520100000002' + '00000000' + '040000'),
        ('tailE=1', host('probe-tailE=1', tail='010100000002020001'), 'probe-tailE=1', 2, 'elwynn', '010001',
         '0200000049520100000002' + '00000000' + '020001'),
        ('password', host('probe-password', pw='pw'), 'probe-password', 2, 'elwynn', '010101', IR),
    ]
    ok = True
    guest = await websockets.connect('ws://127.0.0.1:%d/coop/lobby/' % port)
    for label, frame, name, cls, zone, flags, ctail in cases:
        h = await websockets.connect('ws://127.0.0.1:%d/coop/lobby/' % port)
        await h.send(frame)
        await h.recv(); code = cs.Reader((await h.recv())[1:]).str(); await h.recv()
        await guest.send(b'\x02')
        got = await guest.recv()
        want = entry(code, name, cls, zone, flags, ctail)
        good = got == want
        ok &= good
        print(('PASS ' if good else 'FAIL ') + 'official list entry, lobby "%s"' % label + ('' if good else '\n  got  %s\n  want %s' % (got.hex(), want.hex())))
        await h.close()
        await asyncio.sleep(0.1)
    # open byte 0 -> not listed; full lobby -> not listed
    h = await websockets.connect('ws://127.0.0.1:%d/coop/lobby/' % port)
    await h.send(host('probe-closed', tail='000100000002020000'))
    await h.recv(); await h.recv(); await h.recv()
    await guest.send(b'\x02')
    good = await guest.recv() == b'\x14\x00\x00\x00\x00'
    ok &= good
    print(('PASS ' if good else 'FAIL ') + 'lobby with open byte 0 is not listed')
    await h.close()
    await guest.close()
    return ok

async def main():
    logging.basicConfig(level=logging.WARNING)
    srv = asyncio.create_task(cs.serve('127.0.0.1', 18765, trace=False, country='IR'))
    await asyncio.sleep(0.5)
    ok = await run(18765)
    ok &= await official_entries(18765)
    srv.cancel()
    print('ALL PASS' if ok else 'SOME FAILED')
    sys.exit(0 if ok else 1)

asyncio.run(main())
