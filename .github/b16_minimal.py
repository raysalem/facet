"""B16 minimal repro (no pytest, no app): H9 = a fresh connection's first prepare of an
INSERT on photos (FTS5 sync triggers pull photos_fts in) racing another connection's
ANALYZE photos. Runs for SECONDS, prints counts and the SQLite version."""
import os, sqlite3, sys, tempfile, threading, time, collections
sys.path.insert(0, os.getcwd())
from db.schema import init_database

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 60
path = os.path.join(tempfile.mkdtemp(prefix="b16min_"), "lib.db")
init_database(path)
results = collections.Counter(); i = 0
deadline = time.monotonic() + seconds
while time.monotonic() < deadline:
    i += 1
    seed = sqlite3.connect(path)                    # fresh connection, schema not loaded yet
    go = threading.Barrier(2)
    def analyzer():
        c = sqlite3.connect(path, isolation_level=None)
        c.execute("PRAGMA busy_timeout = 5000")
        go.wait()
        c.execute("ANALYZE photos")                 # changes the schema cookie
        c.close()
    t = threading.Thread(target=analyzer); t.start(); go.wait()
    try:
        seed.execute("INSERT OR REPLACE INTO photos (path, filename) VALUES (?, ?)", (f"/m/{i % 50}.jpg", "x.jpg"))
        seed.commit(); results["ok"] += 1
    except sqlite3.OperationalError as ex:
        results[str(ex)] += 1
    t.join(); seed.close()
print(f"python {sys.version.split()[0]} sqlite {sqlite3.sqlite_version}: {i} iterations in {seconds:.0f}s -> {dict(results)}")
sys.exit(1 if any(k != "ok" for k in results) else 0)
