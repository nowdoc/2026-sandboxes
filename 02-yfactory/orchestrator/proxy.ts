// HTTP and WebSocket pass-through; the caller picks the target and the headers. Same file in sandbox/.
import http from "node:http";
import type { Duplex } from "node:stream";

export type Target = { host: string; port: number; path: string; headers: http.OutgoingHttpHeaders };

const HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"];
const strip = (h: http.IncomingHttpHeaders) => Object.fromEntries(Object.entries(h).filter(([k]) => !HOP.includes(k)));

export function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, t: Target) {
  const up = http.request({ host: t.host, port: t.port, path: t.path, method: req.method, headers: t.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, strip(r.headers));
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on("close", () => up.destroy());
  req.pipe(up);
}

export function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, t: Target) {
  const up = http.request({ host: t.host, port: t.port, path: t.path, method: req.method, headers: t.headers });
  up.on("upgrade", (r, s, h) => {
    const lines = [`HTTP/1.1 101 ${r.statusMessage ?? "Switching Protocols"}`];
    for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (h.length) socket.write(h);
    if (head.length) s.write(head);
    s.pipe(socket);
    socket.pipe(s);
    const end = () => { s.destroy(); socket.destroy(); };
    s.on("error", end); s.on("close", end); socket.on("error", end); socket.on("close", end);
  });
  up.on("response", (r) => { r.resume(); socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\nConnection: close\r\n\r\n`); });
  up.on("error", () => socket.destroy());
  up.end();
}
