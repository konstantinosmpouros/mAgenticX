"""Container healthcheck: ``GET /health`` must answer 200.

Presents the runner's own certificate when TLS material is mounted (the server
requires a client cert under mTLS) and checks the *status code* — a 503 from a
runner whose runsc is broken must mark the container unhealthy. The peer cert
is not verified here: this is the container talking to itself on 127.0.0.1.
"""
import http.client
import os
import ssl
import sys

PORT = int(os.environ.get("SANDBOX_PORT", "8090"))
CERT, KEY = "/app/tls/tls.crt", "/app/tls/tls.key"


def main() -> int:
    """Return 0 when /health answers 200."""
    try:
        if os.access(CERT, os.R_OK) and os.access(KEY, os.R_OK):
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            ctx.load_cert_chain(CERT, KEY)
            conn = http.client.HTTPSConnection("127.0.0.1", PORT, context=ctx, timeout=60)
        else:
            conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=60)
        conn.request("GET", "/health")
        return 0 if conn.getresponse().status == 200 else 1
    except Exception:  # noqa: BLE001 — any failure is unhealthy
        return 1


if __name__ == "__main__":
    sys.exit(main())
