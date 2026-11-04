import os
CSS = open(os.path.join(os.path.dirname(__file__), "style.css")).read()

def svg(w, h, label, body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{label}">
<style>{CSS}</style>
<defs>
<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah"/></marker>
<marker id="av" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah-vm"/></marker>
<marker id="ay" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah-you"/></marker>
</defs>
<rect class="bg" width="{w}" height="{h}" rx="16"/>
{body}
</svg>
'''

def esc(s): return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def card(x, y, w, h, title, *subs, cls="card"):
    cy = y + h / 2 - 7 * len(subs) + 4
    out = [f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="8"/>',
           f'<text class="t" x="{x + w/2}" y="{cy}" text-anchor="middle">{esc(title)}</text>']
    for i, s in enumerate(subs):
        out.append(f'<text class="s" x="{x + w/2}" y="{cy + 16 + i*14}" text-anchor="middle">{esc(s)}</text>')
    return "\n".join(out)

def zone(x, y, w, h, cls, label, sub=None):
    out = [f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="12"/>',
           f'<text class="zl" x="{x+14}" y="{y+20}">{esc(label)}</text>']
    if sub: out.append(f'<text class="s" x="{x+14}" y="{y+34}">{esc(sub)}</text>')
    return "\n".join(out)

def path(d, kind="ln"):
    m = {"ln": "a", "vm": "av", "you": "ay"}[kind]
    return f'<path class="{kind}" d="{d}" marker-end="url(#{m})"/>'

def label(x, y, s, kind="lbl", anchor="middle"):
    return f'<text class="{kind}" x="{x}" y="{y}" text-anchor="{anchor}">{esc(s)}</text>'
