import os
import random
import urllib.request
import urllib.error
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_URL = "https://wow.aethus.pl/data/"
random.seed(42)

groups = defaultdict(list)

with open("scripts/missing_assets.txt", encoding="utf-8") as f:
    for line in f:
        path = line.strip().replace("\\", "/")
        if path:
            ext = os.path.splitext(path)[1].lower()
            groups[ext].append(path)

samples = []

for ext, paths in groups.items():
    count = min(25, len(paths))
    selected = random.sample(paths, count)
    samples.extend((ext, path) for path in selected)

def check(item):
    ext, path = item
    url = BASE_URL + urllib.request.quote(path, safe="/")

    try:
        req = urllib.request.Request(
            url,
            method="HEAD",
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            size = response.headers.get("Content-Length")
            return ext, int(size) if size else None, response.status
    except Exception as e:
        return ext, None, str(e)

results = defaultdict(list)
errors = defaultdict(int)

print(f"Checking {len(samples)} sample files...")

with ThreadPoolExecutor(max_workers=6) as pool:
    futures = [pool.submit(check, item) for item in samples]

    for future in as_completed(futures):
        ext, size, status = future.result()
        if size is not None:
            results[ext].append(size)
        else:
            errors[ext] += 1

estimated_total = 0
known_types = 0

print("\n========== SIZE ESTIMATE ==========")

for ext, paths in sorted(groups.items(), key=lambda x: -len(x[1])):
    sizes = results[ext]

    if sizes:
        average = sum(sizes) / len(sizes)
        estimate = average * len(paths)
        estimated_total += estimate
        known_types += len(paths)

        print(
            f"{ext:8} Missing: {len(paths):6,} | "
            f"Samples: {len(sizes):2} | "
            f"Average: {average / 1024:8.1f} KB | "
            f"Estimated: {estimate / 1024**3:7.2f} GB"
        )
    else:
        print(
            f"{ext:8} Missing: {len(paths):6,} | "
            f"No usable size data"
        )

print("\n========== RESULT ==========")
print(f"Missing files: {sum(map(len, groups.values())):,}")
print(f"Files represented by successful samples: {known_types:,}")
print(f"Estimated size for represented types: {estimated_total / 1024**3:.2f} GB")
print(f"HEAD failures: {sum(errors.values())}")
print("\nThis is an estimate, not an exact download total.")
