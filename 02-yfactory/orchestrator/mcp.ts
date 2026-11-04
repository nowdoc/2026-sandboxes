// Minimal MCP server (streamable HTTP, JSON responses, no sessions); the tools come from the caller.
import type http from "node:http";

const VERSION = "2025-06-18";

export type Tool = { name: string; description: string; inputSchema: object };
export type Backend = { tools: Tool[]; call: (name: string, args: any) => Promise<string> };

async function rpc(msg: any, b: Backend): Promise<unknown> {
  switch (msg.method) {
    case "initialize":
      return { protocolVersion: msg.params?.protocolVersion ?? VERSION, capabilities: { tools: {} }, serverInfo: { name: "yfactory", version: "1" } };
    case "ping": return {};
    case "tools/list": return { tools: b.tools };
    case "tools/call":
      try {
        return { content: [{ type: "text", text: await b.call(msg.params?.name, msg.params?.arguments) }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message.slice(0, 500) : "error" }], isError: true };
      }
    default: throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
  }
}

export async function serve(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer, b: Backend) {
  if (req.method !== "POST") return res.writeHead(405, { Allow: "POST" }).end();
  let msg: any;
  try { msg = JSON.parse(raw.toString()); } catch { return res.writeHead(400).end(); }
  if (msg.id === undefined) return res.writeHead(202).end(); // notification
  let reply;
  try { reply = { jsonrpc: "2.0", id: msg.id, result: await rpc(msg, b) }; } catch (e: any) {
    reply = { jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: String(e.message).slice(0, 300) } };
  }
  const out = Buffer.from(JSON.stringify(reply));
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": out.length }).end(out);
}

