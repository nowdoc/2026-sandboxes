import sys; sys.path.insert(0, sys.argv[1])
from lib import *
b = []
b.append(zone(20, 30, 1120, 180, "z-yf", "ORCHESTRATOR", "trusted · holds every credential"))
b.append(zone(20, 270, 1120, 160, "z-vm", "MICROVM", "untrusted · default-deny"))
b.append('<line class="bnd" x1="20" y1="240" x2="1140" y2="240"/>')
b.append(label(1126, 234, "TRUST BOUNDARY", "lbl-bnd", "end"))

steps = [
  (0, "Admit", "repos.json", "push access"),
  (0, "Mirror", "git fetch", "run repo + hook"),
  (0, "Sandbox", "msb create", "key + run token"),
  (1, "Clone + setup", "via task API :9001", "setup script, root"),
  (1, "Agent", "opencode run", "LLM via :9001"),
  (1, "Push", "commit", "yfactory/<id> only"),
  (0, "Gate", "every commit", "no CI, .git*, links"),
  (0, "Publish", "push with lease", "open PR"),
  (0, "Archive", "sessions to S3", "revoke key, msb rm"),
]
W, GAP, X0, H = 112, 10, 40, 96
ys = [88, 306]
pos = []
for i, (lane, t, s1, s2) in enumerate(steps):
    x, y = X0 + i * (W + GAP), ys[lane]
    pos.append((x, y))
    b.append(card(x, y, W, H, t, s1, s2))
    b.append(f'<circle class="nb" cx="{x+15}" cy="{y+15}" r="9"/>')
    b.append(f'<text class="n" x="{x+15}" y="{y+19}" text-anchor="middle">{i+1}</text>')
for i in range(len(steps) - 1):
    (x1, y1), (x2, y2) = pos[i], pos[i + 1]
    if y1 == y2:
        b.append(path(f"M{x1+W},{y1+H/2} H{x2}", "vm" if steps[i][0] else "ln"))
    elif y2 > y1:
        b.append(path(f"M{x1+W/2},{y1+H} V250 H{x2+W/2} V{y2}"))
        b.append(label((x1 + x2 + W) / 2, 230, "env via stdin"))
    else:
        b.append(path(f"M{x1+W/2},{y1} V250 H{x2+W/2} V{y2+H}", "vm"))
        b.append(label((x1 + x2 + W) / 2, 264, "git push", "lbl-vm"))

b.append(f'<rect class="card" x="20" y="452" width="1120" height="40" rx="20"/>')
b.append(label(42, 476, "keep or empty prompt", "lbl-you", "start"))
b.append(label(190, 476, "VM stays ready after step 3  ·  make shell: opencode and git push  ·  make publish: steps 7–8  ·  make rm: step 9", "lbl", "start"))
print(svg(1160, 512, "Run lifecycle: steps 1 to 3 and 7 to 9 run in the trusted orchestrator, steps 4 to 6 inside the untrusted microVM", "\n".join(b)))
