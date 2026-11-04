# Regenerates the deployment diagrams: python3 diagrams/build.py [out dir, default ../infra/docs]
import os, subprocess, sys
src = os.path.dirname(os.path.abspath(__file__))
out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.normpath(os.path.join(src, "../infra/docs"))
for script, out in [("arch.py", "architecture.svg"), ("run.py", "run-lifecycle.svg"), ("deploy.py", "deploy.svg")]:
    svg = subprocess.run([sys.executable, os.path.join(src, script), src], check=True, capture_output=True, text=True).stdout
    open(os.path.join(out_dir, out), "w").write(svg)
