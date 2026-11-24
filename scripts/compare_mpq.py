import os
import json
from collections import defaultdict

MPQ = "/mnt/c/Users/ADHD/Desktop/AzerothSurvivors_Recovery/mpq_listing/extracted"

with open("data/__index", encoding="utf-8") as f:
    index = json.load(f)

indexed = {p.replace("\\", "/").lower(): p for p in index}
matches = defaultdict(list)
unmatched = []
total_bytes = 0

for root, dirs, files in os.walk(MPQ):
    for filename in files:
        full = os.path.join(root, filename)
        rel = os.path.relpath(full, MPQ).replace("\\", "/")

        # Remove the patch archive directory prefix.
        parts = rel.split("/", 1)
        if len(parts) != 2:
            unmatched.append(rel)
            continue

        asset_path = parts[1]
        key = asset_path.lower()

        if key in indexed:
            size = os.path.getsize(full)
            matches[key].append((full, size))
        else:
            unmatched.append(rel)

unique_bytes = sum(
    max(size for _, size in versions)
    for versions in matches.values()
)

print("========== MPQ COMPARISON ==========")
print("Website index:", len(indexed))
print("Extracted files:", sum(len(v) for v in matches.values()) + len(unmatched))
print("Matching unique assets:", len(matches))
print("Matching extracted size:", f"{unique_bytes / 1024**3:.3f} GB")
print("Matching extracted size:", f"{unique_bytes / 1024**2:.1f} MB")
print("Files not in website index:", len(unmatched))
print("Assets still missing:", len(indexed) - len(matches))

print("\n========== MATCHED EXAMPLES ==========")
for key in list(matches)[:20]:
    print(indexed[key])

print("\n========== UNMATCHED EXAMPLES ==========")
for path in unmatched[:20]:
    print(path)

print("\nNo files were copied or modified.")
