"""B16 minimal repro (no pytest, no app). VARIANT adds the real failure's ingredients:
  base  - plain fresh connection's first INSERT on photos vs a plain connection's ANALYZE photos
  P     - the ANALYZE connection uses Facet's apply_pragmas (mmap_size 2 GB, synchronous NORMAL, ...)
  PX    - P + two more pragma'd connections opening and reading at the same moment (capsules, thumbnail repair)
  PXE   - PX + the seed connection opened EARLY (as the fixture does), then idle, then its first INSERT
Runs for SECONDS, prints counts and the SQLite version; exit 1 on any error."""
import os, sqlite3, sys, tempfile, threading, time, collections
sys.path.insert(0, os.getcwd())
from db.schema import init_database
from db.connection import apply_pragmas

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 60
variant = sys.argv[2] if len(sys.argv) > 2 else "base"
pragmas, extra, early = "P" in variant, "X" in variant, "E" in variant
path = os.path.join(tempfile.mkdtemp(prefix="b16min_"), "lib.db")
init_database(path)

def conn(pragma):
    c = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    if pragma:
        apply_pragmas(c)
    else:
        c.execute("PRAGMA busy_timeout = 5000")
    return c

results = collections.Counter(); i = 0
deadline = time.monotonic() + seconds
while time.monotonic() < deadline:
    i += 1
    seed = sqlite3.connect(path)
    if early:
        time.sleep(0.05)
    n = 2 + (2 if extra else 0)
    go = threading.Barrier(n)
    def analyzer():
        c = conn(pragmas); go.wait(); c.execute("ANALYZE photos"); c.close()
    def reader():
        go.wait(); c = conn(True); c.execute("SELECT count(*) FROM photos").fetchone(); c.close()
    threads = [threading.Thread(target=analyzer)] + [threading.Thread(target=reader) for _ in range(n - 2)]
    for t in threads: t.start()
    go.wait()
    try:
        seed.execute("INSERT OR REPLACE INTO photos (path, filename) VALUES (?, ?)", (f"/m/{i % 50}.jpg", "x.jpg"))
        seed.commit(); results["ok"] += 1
    except sqlite3.OperationalError as ex:
        results[str(ex)] += 1
    for t in threads: t.join()
    seed.close()
print(f"variant {variant} python {sys.version.split()[0]} sqlite {sqlite3.sqlite_version}: {i} iterations in {seconds:.0f}s -> {dict(results)}")
sys.exit(1 if any(k != "ok" for k in results) else 0)
