export class HttpError extends Error {
  name = "HttpError";
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

export async function api(method: string, p: string, body: unknown, opts: { base: string; headers: Record<string, string> }): Promise<any> {
  const res = await fetch(opts.base + p, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: opts.headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new HttpError(`${method} ${p} -> ${res.status}`, res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
