import json
import os
import time
import urllib.request
import urllib.parse
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://wow.aethus.pl/data/"
ROOT = os.path.abspath("data")
INDEX = os.path.join(ROOT, "__index")
FAILURES = "documentation/asset_download_failures.txt"

WORKERS = 8
RETRIES = 4

os.makedirs("documentation", exist_ok=True)

with open(INDEX, encoding="utf-8") as f:
    assets = json.load(f)

total_files = len(assets)
lock = threading.Lock()

downloaded_bytes = 0
downloaded_files = 0
skipped_files = 0
failed_files = 0
active = 0
failures = []

start_time = time.time()
last_update = start_time
last_bytes = 0
speed = 0.0

def download(original_path):
    global downloaded_bytes, downloaded_files
    global skipped_files, failed_files, active

    path = original_path.replace("\\", "/").lstrip("/")
    destination = os.path.abspath(os.path.join(ROOT, path))

    if not destination.startswith(ROOT + os.sep):
        with lock:
            failed_files += 1
            failures.append(f"{original_path} | Invalid path")
        return

    if os.path.isfile(destination) and os.path.getsize(destination) > 0:
        with lock:
            skipped_files += 1
        return

    os.makedirs(os.path.dirname(destination), exist_ok=True)

    url = BASE + urllib.parse.quote(path, safe="/")
    temporary = destination + ".part"

    for attempt in range(RETRIES):
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0"}
            )

            with urllib.request.urlopen(request, timeout=60) as response:
                if response.status != 200:
                    raise Exception(f"HTTP {response.status}")

                with lock:
                    active += 1

                size = 0

                with open(temporary, "wb") as output:
                    while True:
                        chunk = response.read(256 * 1024)
                        if not chunk:
                            break

                        output.write(chunk)
                        size += len(chunk)

                        with lock:
                            downloaded_bytes += len(chunk)

                with lock:
                    active -= 1

            if size == 0:
                raise Exception("Empty response")

            os.replace(temporary, destination)

            with lock:
                downloaded_files += 1

            return

        except Exception as error:
            with lock:
                if active:
                    active -= 1

            try:
                if os.path.exists(temporary):
                    os.remove(temporary)
            except OSError:
                pass

            if attempt == RETRIES - 1:
                with lock:
                    failed_files += 1
                    failures.append(f"{original_path} | {error}")
            else:
                time.sleep(2 * (attempt + 1))

def format_size(value):
    return f"{value / 1024**3:.3f} GB"

def display():
    global last_update, last_bytes, speed

    while True:
        time.sleep(1)

        with lock:
            done = downloaded_files + skipped_files + failed_files
            current_bytes = downloaded_bytes
            current_downloaded = downloaded_files
            current_skipped = skipped_files
            current_failed = failed_files
            current_active = active

        now = time.time()
        elapsed = now - last_update

        if elapsed > 0:
            instant_speed = (current_bytes - last_bytes) / elapsed
            speed = speed * 0.65 + instant_speed * 0.35

        last_update = now
        last_bytes = current_bytes

        percent = done / total_files * 100 if total_files else 100
        elapsed_total = now - start_time
        remaining_files = total_files - done

        eta = (
            remaining_files * elapsed_total / done
            if done > 0 else 0
        )

        bar_width = 30
        filled = int(bar_width * percent / 100)
        bar = "█" * filled + "░" * (bar_width - filled)

        print(
            f"\r[{bar}] {percent:5.1f}% | "
            f"{done:,}/{total_files:,} files | "
            f"{format_size(current_bytes)} downloaded | "
            f"{speed / 1024 / 1024:.2f} MB/s | "
            f"ETA {eta / 60:.1f} min | "
            f"Active {current_active} | "
            f"Failed {current_failed}",
            end="", flush=True
        )

        if done >= total_files:
            break

print(f"Starting download of {total_files:,} indexed assets...")
print(f"Workers: {WORKERS}")
print("Speed is measured from actual downloaded bytes.")
print()

with ThreadPoolExecutor(max_workers=WORKERS) as executor:
    futures = [executor.submit(download, path) for path in assets]

    display_thread = threading.Thread(target=display)
    display_thread.start()

    for future in as_completed(futures):
        future.result()

    display_thread.join()

print("\n\n===== DOWNLOAD COMPLETE =====")
print("Downloaded:", downloaded_files)
print("Already present:", skipped_files)
print("Failed:", failed_files)
print("Total downloaded:", format_size(downloaded_bytes))
print("Elapsed:", f"{(time.time() - start_time) / 60:.1f} minutes")

with open(FAILURES, "w", encoding="utf-8") as f:
    f.write("\n".join(failures))

print("Failure log:", FAILURES)
