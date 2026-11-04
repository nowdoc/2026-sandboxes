// CLI pro adapter: create <template> <json-network|-> | exec <id> <timeoutMs> <cmd> (stdin -> command stdin) | destroy <id>
import { Sandbox } from 'e2b'
const USER = process.env.E2B_USER || 'root'
const [op, ...a] = process.argv.slice(2)
const out = (o) => process.stdout.write(JSON.stringify(o))
if (op === 'create') {
  const net = a[1] && a[1] !== '-' ? JSON.parse(a[1]) : undefined
  const s = await Sandbox.create(a[0], { timeoutMs: 3600000, network: net, metadata: { task: a[2] || '' } })
  out({ id: s.sandboxId })
} else if (op === 'exec') {
  const s = await Sandbox.connect(a[0])
  const chunks = []; if (!process.stdin.isTTY) for await (const c of process.stdin) chunks.push(c)
  const input = Buffer.concat(chunks)
  let r
  try {
    if (input.length) {
      const h = await s.commands.run(a[2], { background: true, stdin: true, timeoutMs: +a[1], user: USER })
      await h.sendStdin(new Uint8Array(input))
      await s.commands.closeStdin(h.pid).catch(() => {}) // tar skonci po konci archivu, drive nez prijde EOF
      r = await h.wait()
    } else r = await s.commands.run(a[2], { timeoutMs: +a[1], user: USER })
  } catch (e) { r = e }
  out({ code: r.exitCode ?? 1, stdout: Buffer.from(r.stdout || '', 'utf8').toString('base64'), stderr: Buffer.from(r.stderr || r.message || '', 'utf8').toString('base64') })
} else if (op === 'list') {
  const p = Sandbox.list(); const r = []
  while (p.hasNext) for (const x of await p.nextItems()) r.push({ id: x.sandboxId, task: (x.metadata || {}).task || '' })
  out(r)
} else if (op === 'destroy') { await Sandbox.kill(a[0]); out({ ok: true }) }
