#!/usr/bin/env python3
"""Run Folio on this computer. Nothing is uploaded."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import json
import urllib.request
import webbrowser

APP_DIR = Path(__file__).resolve().parent
URL = "http://127.0.0.1:4337"


class FolioHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".pdf": "application/pdf",
        ".bcmap": "application/octet-stream",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):
        if self.path == "/__folio_health":
            data = b'{"app":"folio","version":1}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def log_message(self, *_):
        pass


def main():
    parser = argparse.ArgumentParser(description="Start your local Folio reader")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    try:
        with urllib.request.urlopen(URL + "/__folio_health", timeout=1) as response:
            if json.load(response).get("app") == "folio":
                print("Folio is already running at " + URL)
                if not args.no_browser:
                    webbrowser.open(URL)
                return
    except Exception:
        pass
    try:
        server = ThreadingHTTPServer(
            ("127.0.0.1", 4337),
            partial(FolioHandler, directory=str(APP_DIR / "dist")),
        )
    except OSError:
        raise SystemExit("Port 4337 is in use. Close the other local app and start Folio again.")
    print("Folio is ready at " + URL, flush=True)
    print("Keep this window open while reading. Press Control+C to stop.", flush=True)
    if not args.no_browser:
        webbrowser.open(URL)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
