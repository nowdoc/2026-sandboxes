#!/usr/bin/env python3
"""Runs inside a run's VM as agent, with ~/.yf-env loaded. Prints {"blocked": {...}, "works": {...}}.

A blocked check is True when the attack failed. Targets come from the harness as JSON on stdin.
"""
import json, os, socket, struct, sys, urllib.error, urllib.request

cfg = json.load(sys.stdin)
GW = os.environ["TASK_API_URL"].split("//")[1].split(":")[0]
LLM, TASK = os.environ["LLM_BASE_URL"], os.environ["TASK_API_URL"]
TOKEN = KEY = os.environ["YF_TOKEN"]  # the run token is the only credential, also for the LLM routes
assert "LLM_API_KEY" not in os.environ
PROXY = os.environ.get("HTTPS_PROXY")
direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
via = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY} if PROXY else {}))


def tcp_blocked(host, port):
    try:
        s = socket.create_connection((host, port), timeout=4)
    except OSError:
        return True
    # msb accepts some denied connections itself and answers with its policy error instead of reaching the target.
    try:
        s.sendall(f"GET / HTTP/1.0\r\nHost: {host}\r\n\r\n".encode())
        s.settimeout(4)
        data = s.recv(512)
        return b"network_policy_denied" in data or not data
    except socket.timeout:
        return False
    except OSError:
        return True
    finally:
        s.close()


def dns_tcp_blocked(host):
    # A real query: msb may accept TCP on :53 itself, so only an answer with records counts as reachable.
    q = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + b"".join(bytes([len(p)]) + p.encode() for p in "example.com".split(".")) + b"\0" + struct.pack(">HH", 1, 1)
    try:
        s = socket.create_connection((host, 53), timeout=4)
        s.settimeout(4)
        s.sendall(struct.pack(">H", len(q)) + q)
        data = s.recv(4096)
        s.close()
    except OSError:
        return True
    return len(data) < 14 or struct.unpack(">H", data[8:10])[0] == 0


def status(url, opener=direct, method=None, data=None, token=None, ctype="application/json"):
    headers = {"Content-Type": ctype}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    try:
        r = opener.open(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=20)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return None, str(e).encode()


def dns_blocked():
    try:
        socket.getaddrinfo("example.com", 443)
        return False
    except OSError:
        return True


def default_gateway():
    with open("/proc/net/route") as f:
        for line in f.readlines()[1:]:
            p = line.split()
            if p[1] == "00000000":
                return socket.inet_ntoa(struct.pack("<L", int(p[2], 16)))
    return None




blocked, works = {}, {}
for host, port in cfg["tcp"]:
    if port == 53:
        blocked[f"dns over tcp {host}:53"] = dns_tcp_blocked(host)
    else:
        blocked[f"tcp {host}:{port}"] = tcp_blocked(host, port)
gw = default_gateway()
if gw:
    for port in (22, 80, 7000, 8080, 8443, *range(20000, 20011)):
        blocked[f"tcp vm default gateway {gw}:{port}"] = tcp_blocked(gw, port)
blocked["dns example.com"] = dns_blocked()

if PROXY:
    for url in cfg["proxy_internal"]:
        blocked[f"proxy to {url}"] = status(url, via)[0] != 200
    blocked["proxy to https://example.com/"] = status("https://example.com/", via)[0] != 200
    works["proxy to https://pypi.org/simple/pip/"] = status("https://pypi.org/simple/pip/", via)[0] == 200

works["llm /v1/models"] = status(LLM + "/v1/models", token=KEY)[0] == 200
chat = json.dumps({"model": cfg["model"], "max_tokens": 1, "messages": [{"role": "user", "content": "Say ok"}]}).encode()
works["llm chat completion"] = status(LLM + "/v1/chat/completions", data=chat, token=KEY)[0] == 200
for path, data in [("/key/generate", b"{}"), ("/key/info", None), ("/v1/models/../../key/info", None), ("/v1/../key/generate", b"{}"),
                   ("/health", None), ("/metrics", None), ("/user/new", b"{}"), ("/model/new", b"{}")]:
    blocked[f"task api LLM side {path}"] = status(LLM + path, data=data, token=KEY)[0] in (403, 404)

for path in ["/", "/api/runs", "/metrics", "/health", "/internal/auth"]:
    blocked[f"task api {path}"] = status(TASK + path, token=TOKEN)[0] in (403, 404)

blocked["task api has no /mcp"] = status(TASK + "/mcp", data=b"{}", token=TOKEN)[0] == 404

own = f"{TASK}/git/{os.environ['YF_RUN']}.git/info/refs?service=git-upload-pack"
peer = f"{TASK}/git/{cfg['peer_run']}.git/info/refs?service=git-upload-pack"
works["git info/refs own run"] = status(own, token=TOKEN)[0] == 200
blocked["git info/refs without token"] = status(own)[0] == 401
blocked["git info/refs bad token"] = status(own, token="x" * 43)[0] == 401
blocked["git info/refs other run with own token"] = status(peer, token=TOKEN)[0] == 403
blocked["git path escape"] = status(f"{TASK}/git/{os.environ['YF_RUN']}.git/../../mirrors/{os.environ['YF_REPO']}.git/info/refs?service=git-upload-pack", token=TOKEN)[0] in (403, 404)

print(json.dumps({"blocked": blocked, "works": works}))
