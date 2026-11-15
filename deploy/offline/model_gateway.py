"""Restricted, credential-free relay to an explicitly selected private model engine."""
import http.client
import ipaddress
import socket
import socketserver
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROUTES = {"/v1/chat/completions", "/v1/completions", "/v1/responses", "/v1/embeddings"}


def upstream_address(base_url):
    """Validate an HTTP private IP engine without DNS, credentials, or redirects."""
    url = urlsplit(base_url)
    if url.scheme != "http" or url.username or url.password or url.query or url.fragment:
        raise ValueError("Model URL must be credential-free private HTTP")
    try:
        address = ipaddress.ip_address(url.hostname)
    except (ValueError, TypeError) as error:
        raise ValueError("Model URL must use a literal private or loopback IP") from error
    if not (address.is_loopback or address in ipaddress.ip_network("10.0.0.0/8") or address in ipaddress.ip_network("172.16.0.0/12") or address in ipaddress.ip_network("192.168.0.0/16")):
        raise ValueError("Model URL must use a private or loopback IP")
    if url.path.rstrip("/") != "/v1":
        raise ValueError("Model URL path must be /v1")
    return str(address), url.port or 80


def _handler(base_url, max_body):
    """Build the restricted relay handler shared by TCP and Unix listeners."""
    upstream_host, upstream_port = upstream_address(base_url)
    if max_body < 1:
        raise ValueError("Body limit must be positive")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def reject(self, status):
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

        def do_GET(self):
            self.relay()

        def do_POST(self):
            self.relay()

        def relay(self):
            if not (self.command == "GET" and self.path == "/v1/models" or self.command == "POST" and self.path in ROUTES):
                return self.reject(403)
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) > 1:
                return self.reject(400)
            try:
                length = int(lengths[0]) if lengths else 0
            except ValueError:
                return self.reject(400)
            if length < 0 or length > max_body:
                return self.reject(413)
            self.connection.settimeout(30)
            started = False
            try:
                body = self.rfile.read(length)
                if len(body) != length:
                    return self.reject(400)
                connection = http.client.HTTPConnection(upstream_host, upstream_port, timeout=300)
                connection.request(self.command, self.path, body=body, headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
                response = connection.getresponse()
                if 300 <= response.status < 400:
                    connection.close()
                    return self.reject(502)
                started = True
                self.send_response(response.status)
                self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                while chunk := response.read1(65536):
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (OSError, http.client.HTTPException):
                if not started:
                    self.reject(502)
                self.close_connection = True
            finally:
                if "connection" in locals():
                    connection.close()

    return Handler


def make_server(bind, port, base_url, max_body=16 * 1024 * 1024):
    """Create a route-limited TCP relay; request contents never enter access logs."""
    server = ThreadingHTTPServer((bind, port), _handler(base_url, max_body))
    server.daemon_threads = True
    return server


class ThreadingUnixHTTPServer(ThreadingHTTPServer):
    """Serve HTTP on a pathname Unix socket without adding a host TCP listener."""

    address_family = socket.AF_UNIX

    def server_bind(self):
        self.socket.bind(self.server_address)
        self.server_address = self.socket.getsockname()


def make_unix_server(path, base_url, max_body=16 * 1024 * 1024):
    """Create a route-limited relay on a Unix socket for a single mounted runtime."""
    server = ThreadingUnixHTTPServer(str(path), _handler(base_url, max_body))
    server.daemon_threads = True
    return server
