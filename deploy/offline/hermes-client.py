#!/usr/bin/env python3
"""Bridge one stdio ACP child to the mounted Hermes Unix socket."""

import socket
import sys
import threading


def main():
    """Copy the ACP request and response without logging or retrying task data."""
    path = sys.argv[1] if len(sys.argv) == 2 else "/run/hermes-acp/agent.sock"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(path)

        def upload():
            try:
                while chunk := sys.stdin.buffer.read1(65536):
                    connection.sendall(chunk)
                connection.shutdown(socket.SHUT_WR)
            except OSError:
                return

        threading.Thread(target=upload, daemon=True).start()
        while chunk := connection.recv(65536):
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except OSError:
        print("Hermes ACP socket unavailable; task was not retried", file=sys.stderr)
        raise SystemExit(1) from None
