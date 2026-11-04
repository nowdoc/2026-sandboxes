#!/usr/bin/env python3
"""Smoke test adapteru + probe. Spust: MSB_BIN=... MSB_HOME=... python3 run_adapter.py"""
import json, os, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "orchestrator"))
from adapters.microsandbox import MicrosandboxRuntime
rt = MicrosandboxRuntime()
t0 = time.time(); sb = rt.create("probe"); r = rt.exec(sb, "echo ok"); cold = time.time() - t0
print("cold", round(cold, 2), r.stdout, r.stderr[:200])
probe = open(os.path.join(ROOT, "tests/probe.py"), "rb").read()
r = rt.exec(sb, "python3 - " + "'{}'", stdin=probe)
print(r.returncode, r.stdout.decode(), r.stderr.decode()[-500:])
r = rt.exec(sb, "tar xf - -C /tmp && ls /tmp/x", stdin=__import__("subprocess").run(["tar","-cf","-","-C",os.path.join(ROOT, "runtimes/microsandbox"),"--transform","s,^,x/,","run_adapter.py"],capture_output=True).stdout)
print("tar via stdin", r.returncode, r.stdout.decode(), r.stderr.decode()[:200])
print(sb)
rt.destroy(sb)
