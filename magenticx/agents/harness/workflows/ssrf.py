"""SSRF guard for the ``fetch`` node: only public addresses, checked per hop.

A workflow's URLs are owner-authored *and* templated from run data (a fetched
page can supply the next URL), so the agents service — which sits on the
internal network next to Postgres, Redis, the bridge and the sandbox runner —
must never be turned into a proxy into it. The rules:

* ``http`` / ``https`` only; no credentials in the URL.
* The host is resolved here, and **every** address it resolves to must be
  public — a mixed answer (one public, one private) is refused, fail-closed.
* The request is then sent **to the address that was checked** (the URL's host
  is swapped for the IP; ``Host`` and TLS SNI keep the name, so certificates
  still verify). A second DNS lookup by the HTTP client — the DNS-rebinding
  hole — never happens.
* Redirects are not followed by the client; ``fetch`` follows them itself and
  runs every hop through this guard again.

Blocked: private (RFC 1918, ULA), loopback, link-local (which covers the cloud
metadata address ``169.254.169.254``), CGNAT ``100.64.0.0/10``, multicast,
reserved, unspecified, documentation/benchmark ranges, and IPv6 forms that
embed an IPv4 address (mapped, NAT64, 6to4, Teredo) when the embedded one is
blocked.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

from harness.workflows.errors import NodeExecutionError

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

ALLOWED_SCHEMES = ("http", "https")

#: Spelled out on top of ``is_global`` so the policy is readable and does not
#: depend on one Python version's idea of "global".
BLOCKED_NETWORKS = tuple(
    ipaddress.ip_network(net)
    for net in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "::/128",
        "::1/128",
        "64:ff9b::/96",
        "64:ff9b:1::/48",
        "100::/64",
        "2001:db8::/32",
        "fc00::/7",
        "fe80::/10",
        "fec0::/10",
        "ff00::/8",
    )
)


class SSRFBlocked(NodeExecutionError):
    """The URL or an address it resolves to is not allowed."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="ssrf_blocked")


@dataclass(frozen=True)
class Target:
    """A checked URL: where to connect, and the name to present."""

    scheme: str
    host: str
    port: int
    addresses: tuple[str, ...]


def is_blocked_address(ip: IPAddress) -> bool:
    """Whether a request may not go to this address."""
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = [ip.ipv4_mapped, ip.sixtofour, *(ip.teredo or ())]
        if any(inner is not None and is_blocked_address(inner) for inner in embedded):
            return True
    if any(ip in net for net in BLOCKED_NETWORKS if net.version == ip.version):
        return True
    return (
        not ip.is_global
        or ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def check_url(url: str) -> Target:
    """Validate a URL's shape; resolution is :func:`resolve_target`'s job."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise SSRFBlocked("The URL is malformed.") from exc
    scheme = (parts.scheme or "").lower()
    if scheme not in ALLOWED_SCHEMES:
        raise SSRFBlocked("Only http and https URLs can be fetched.")
    if parts.username or parts.password:
        raise SSRFBlocked("URLs with credentials are not allowed; send them as a header.")
    host = (parts.hostname or "").strip().rstrip(".").lower()
    if not host:
        raise SSRFBlocked("The URL has no host.")
    return Target(scheme=scheme, host=host, port=port or (443 if scheme == "https" else 80), addresses=())


async def resolve_host(host: str, port: int) -> list[str]:
    """Every address ``host`` resolves to (a literal IP resolves to itself).

    Module-level so tests can substitute a fixed answer.
    """
    try:
        return [str(ipaddress.ip_address(host))]
    except ValueError:
        pass
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise NodeExecutionError("The host could not be resolved.", code="dns") from exc
    # Strip an IPv6 zone id ("fe80::1%eth0") before parsing.
    return list(dict.fromkeys(str(info[4][0]).split("%", 1)[0] for info in infos))


async def resolve_target(url: str) -> Target:
    """Check a URL and resolve it to public addresses only — or raise."""
    target = check_url(url)
    addresses = await resolve_host(target.host, target.port)
    if not addresses:
        raise NodeExecutionError("The host could not be resolved.", code="dns")
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as exc:
            raise SSRFBlocked("The host resolved to an invalid address.") from exc
        if is_blocked_address(ip):
            raise SSRFBlocked("The URL points to a private or reserved address.")
    return Target(scheme=target.scheme, host=target.host, port=target.port, addresses=tuple(addresses))


__all__ = [
    "ALLOWED_SCHEMES",
    "BLOCKED_NETWORKS",
    "SSRFBlocked",
    "Target",
    "check_url",
    "is_blocked_address",
    "resolve_host",
    "resolve_target",
]
