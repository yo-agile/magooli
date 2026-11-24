#!/usr/bin/env python3
"""Delete junk files that are not needed to run the server."""
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent.parent

KEEP = {'serve.py', 'coop_server.py', 'coop_selftest.py'}
SKIP_DIRS = {'node_modules', '.venv', 'venv', '.git', 'site-packages', 'data', 'public'}

NAMES = [
    '__pycache__', 'server.pid', 'powershell', 'coop_unknown.log',
    'coop_selftest_debug.py', 'missing_assets.txt',
]
PATTERNS = [
    '*.bak', '*.orig', '*.rej', '*.pyc', '*.pyo',
    'probe_official*.py', 'probe*_result.json', 'webgpu_probe*.js',
]

removed = 0
for p in sorted(root.rglob('*')):
    if not p.exists():
        continue
    rel = p.relative_to(root)
    if any(part in SKIP_DIRS for part in rel.parts):
        continue
    if p.name in KEEP:
        continue
    if p.name in NAMES or any(p.match(pat) for pat in PATTERNS):
        try:
            shutil.rmtree(p) if p.is_dir() else p.unlink()
            print('removed', rel)
            removed += 1
        except OSError as e:
            print('could not remove', rel, '-', e)

print(f'\ndone, {removed} item(s) removed')