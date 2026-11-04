// Browser WebSocket to a VM shell. No library: the handshake and the few frame types a terminal needs are small.
import { createHash } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { inc } from "./metrics.ts";
import * as sandbox from "./sandbox.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 1024 * 1024;
const MAX_OPEN = 8;
let open = 0;

function frame(op: number, data: Buffer): Buffer {
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), Buffer.alloc(8)]);
  if (n >= 65536) head.writeBigUInt64BE(BigInt(n), 2);
  return Buffer.concat([head, data]);
}

// Cross-site pages must not be able to open a shell: the UI has no login, so the Origin has to be this host.
export function sameOrigin(req: http.IncomingMessage): boolean {
  try { return new URL(req.headers.origin ?? "").host === req.headers.host; } catch { return false; }
}

export async function accept(req: http.IncomingMessage, socket: Duplex, head: Buffer, vm: string) {
  const reject = (code: number, why: string) => { socket.end(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); };
  const key = req.headers["sec-websocket-key"];
  if (!key || req.headers.upgrade?.toLowerCase() !== "websocket") return reject(400, "Bad Request");
  if (open >= MAX_OPEN) return reject(429, "Too Many Requests");
  const q = new URL(req.url!, "http://ui").searchParams;
  let term;
  open++;
  try { term = await sandbox.shell(vm, Number(q.get("rows")) || 24, Number(q.get("cols")) || 80); } catch { open--; return reject(502, "Bad Gateway"); }
  inc("yf_terminals_total");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`);
  const send = (op: number, d: Buffer) => { if (!socket.destroyed) socket.write(frame(op, d)); };
  let closed = false;
  const close = (code = 1000) => {
    if (closed) return;
    closed = true; open--;
    clearInterval(ping);
    term.req.destroy(); term.res.destroy();
    if (!socket.destroyed) socket.end(frame(8, Buffer.from([code >> 8, code & 255])));
  };
  const ping = setInterval(() => send(9, Buffer.alloc(0)), 25_000);
  term.res.on("data", (d: Buffer) => send(2, d));
  term.res.on("end", () => close(1000));
  term.res.on("error", () => close(1011));
  term.req.on("error", () => close(1011));
  socket.on("close", () => close());
  socket.on("error", () => close());

  let buf = head;
  let message: Buffer[] = [];
  socket.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80), op = buf[0] & 15, masked = !!(buf[1] & 0x80);
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > MAX_FRAME) return close(1002);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return close(1000);
      if (op === 9) send(10, data);
      else if (op === 0 || op === 1 || op === 2) {
        message.push(data);
        if (fin) { term.req.write(Buffer.concat(message)); message = []; }
      }
    }
  });
}
