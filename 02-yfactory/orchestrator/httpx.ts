import type http from "node:http";

export function body(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => { size += d.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(d); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function json(res: http.ServerResponse, code: number, data: unknown) {
  const raw = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": raw.length }).end(raw);
}

