"""A fake supervised add-on for tests/test_addons_supervisor.py (run as a separate process).

Flags: --bad-ack (wrong health answer), --no-port (never prints the port line), --crash-after N
(exit with code 3 N seconds after reporting ready). It starts one grandchild (a sleeping Python) and
writes both pids to ``pids.json`` in its working directory, so a test can prove the whole tree ends.
"""

import hashlib
import hmac
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SECRET = os.environ.get("FACET_LAUNCH_SECRET", "")
ADDON_ID = os.environ.get("FACET_ADDON_ID", "")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        sys.stderr.write("request " + (args[0] % args[1:]) + "\n")

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/health":
            c = parse_qs(url.query).get("c", [""])[0]
            if not c or len(c) > 512:
                return self._json(400, {"error": "c"})
            ack = hmac.new(SECRET.encode(), c.encode(), hashlib.sha256).hexdigest()
            if "--bad-ack" in sys.argv:
                ack = "0" * 64
            return self._json(200, {"addon": ADDON_ID, "ack": ack})
        if not hmac.compare_digest((self.headers.get("X-Facet-Launch") or "").encode(), SECRET.encode()):
            return self._json(403, {"error": "launch"})
        if url.path == "/ui/":
            data = b"<!doctype html><p>child</p>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if url.path == "/env":
            return self._json(200, {"env": dict(os.environ), "cwd": os.getcwd(), "host": self.headers.get("Host")})
        return self._json(404, {})


def main():
    grandchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
    with open("pids.json", "w", encoding="utf-8") as handle:
        json.dump({"child": os.getpid(), "grandchild": grandchild.pid}, handle)
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("FACET_PORT", "0"))), Handler)
    sys.stderr.write("fake add-on starting\n")
    if "--no-port" not in sys.argv:
        sys.stdout.write(f"FACET_ADDON_PORT={server.server_address[1]}\n")
        sys.stdout.flush()
    if "--crash-after" in sys.argv:
        delay = float(sys.argv[sys.argv.index("--crash-after") + 1])
        threading.Thread(target=lambda: (time.sleep(delay), os._exit(3)), daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
