#!/usr/bin/env python3
"""Bezi uvnitr sandboxu. Kazdy test vraci True, kdyz je utok ZABLOKOVAN."""
import json, os, socket, sys, urllib.error, urllib.request

extra = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
HOST = extra.get("host") or os.environ.get("FACTORY_HOST", "127.0.0.1")
direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# sbx: transparent proxy prijme TCP connect, proto tcp_blocked testuje i prenos dat

LLM = os.environ.get("LLM_BASE_URL", "http://llm-gw:4000")
PROXY = os.environ.get("HTTPS_PROXY", "http://pkg-gw:3128")


def tcp_blocked(host, port):
    try:
        c = socket.create_connection((host, port), timeout=4)
        c.settimeout(3)
        try:
            c.sendall(b"GET / HTTP/1.0\r\n\r\n")
            data = c.recv(100)
        except OSError:
            data = b""
        c.close()
        return not data
    except OSError:
        return True


def http_status(url, opener=direct, data=None):
    try:
        return opener.open(urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}), timeout=10).status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


def dns_blocked():
    try:
        socket.getaddrinfo("example.com", 443)
        return False
    except OSError:
        return True


via = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
chat = json.dumps({"model": "mock", "messages": [{"role": "user", "content": "x"}]}).encode()
blocked = {
    "direct_ip_internet": tcp_blocked("1.1.1.1", 443),
    "external_dns": dns_blocked(),
    "metadata_ip": tcp_blocked("169.254.169.254", 80),
    "lan_router": tcp_blocked("192.168.1.1", 80),
    "host_lan_ssh": tcp_blocked(HOST, 22),
    "forgejo_by_name": tcp_blocked("forgejo", 3000),
    "litellm_by_name": tcp_blocked("litellm", 4000),
    "proxy_to_nonallowed_domain": http_status("https://example.com/", via) != 200,
    "proxy_to_internal_forgejo": http_status("http://forgejo:3000/api/healthz", via) != 200,
    "litellm_admin_via_gateway": http_status(LLM + "/key/info") == 403,
    "litellm_keygen_via_gateway": http_status(LLM + "/key/generate", data=b"{}") == 403,
}
for host, port in extra.get("tcp", []):
    blocked[f"tcp_{host}_{port}"] = tcp_blocked(host, port)
works = {
    "llm_via_gateway": http_status(LLM + "/v1/chat/completions", data=chat) == 200,
    "packages_via_proxy": http_status("https://pypi.org/simple/pip/", via) == 200,
}
print(json.dumps({"blocked": blocked, "works": works}))
