"""Bridge DSH's loopback HTTP client to its mounted private model socket."""
import argparse
import select
import socket
import socketserver
from pathlib import Path


class ThreadingProxyServer(socketserver.ThreadingTCPServer):
    """Accept loopback clients and connect them to one mounted Unix socket."""

    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, socket_path, port):
        self.socket_path = socket_path
        super().__init__(("127.0.0.1", port), ProxyHandler)


class ProxyHandler(socketserver.BaseRequestHandler):
    """Copy each HTTP byte stream without parsing or logging its contents."""

    def handle(self):
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect(self.server.socket_path)
            peers = {self.request: upstream, upstream: self.request}
            open_sockets = set(peers)
            while open_sockets:
                readable, _, _ = select.select(open_sockets, (), ())
                for source in readable:
                    try:
                        data = source.recv(65536)
                    except OSError:
                        data = b""
                    target = peers[source]
                    if data:
                        target.sendall(data)
                    else:
                        open_sockets.remove(source)
                        try:
                            target.shutdown(socket.SHUT_WR)
                        except OSError:
                            pass
        except OSError:
            return
        finally:
            upstream.close()


def make_proxy_server(socket_path, port):
    """Create a loopback-only proxy for one mounted Unix socket."""
    if not 0 <= port <= 65535:
        raise ValueError("Proxy port must be a valid TCP port")
    server = ThreadingProxyServer(str(socket_path), port)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--ready-file", type=Path, required=True)
    args = parser.parse_args()
    if not args.ready_file.is_absolute():
        parser.error("Ready file must use an absolute path")
    if not 1024 <= args.port <= 65535:
        parser.error("Proxy port must be an unprivileged TCP port")
    server = make_proxy_server(args.socket, args.port)
    descriptor = args.ready_file.open("x")
    descriptor.close()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 130
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
