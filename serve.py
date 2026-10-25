#!/usr/bin/env python3
"""Minimal static dev server that disables caching.

`python -m http.server` lets the browser cache ES modules aggressively, so
edits to imported .js files don't take effect on reload. This sends
`Cache-Control: no-store` on every response so each reload fetches fresh code.

Usage: python3 serve.py [port]   (serves this file's directory)
"""
import functools
import http.server
import os
import socketserver
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8778
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", port), handler) as httpd:
        print(f"Serving {root} on http://localhost:{port} (no-store)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
