import os
import json
import shutil

MPQ = "/mnt/c/Users/ADHD/Desktop/AzerothSurvivors_Recovery/mpq_listing/extracted"
DATA = "data"
INDEX = "data/__index"

with open(INDEX, encoding="utf-8") as f:
    index = json.load(f)

indexed = {
    p.replace("\\", "/").lower(): p.replace("\\", "/")
    for p in index
}

sources = {}

for root, dirs, files in os.walk(MPQ):
    for filename in files:
        full = os.path.join(root, filename)
        rel = os.path.relpath(full, MPQ).replace("\\", "/")
        parts = rel.split("/", 1)

        if len(parts) != 2:
            continue

        asset = parts[1]
        key = asset.lower()

        if key in indexed:
            sources[key] = full

copied = 0
skipped = 0
total_bytes = 0

print("Starting MPQ asset recovery...")
print(f"Matching assets available: {len(sources)}")

for key, source in sources.items():
    relative_path = indexed[key]
    destination = os.path.join(DATA, *relative_path.split("/"))

    if os.path.exists(destination):
        skipped += 1
        continue

    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copy2(source, destination)

    copied += 1
    total_bytes += os.path.getsize(destination)

print("\n========== COPY COMPLETE ==========")
print(f"Copied: {copied}")
print(f"Skipped (already existed): {skipped}")
print(f"Copied size: {total_bytes / 1024**2:.2f} MB")
print("Original MPQ extraction was not modified.")
