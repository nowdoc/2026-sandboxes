import { Sandbox } from 'e2b'
import { execSync } from 'node:child_process'
const ts=[]; let s
for (let i=0;i<3;i++){
  const t=Date.now(); s=await Sandbox.create('base',{timeoutMs:600000}); const r=await s.commands.run('echo hi'); ts.push((Date.now()-t)/1000)
  console.log(i, ts[i], r.stdout.trim(), s.sandboxId)
  if(i<2) await s.kill()
}
console.log('sorted',[...ts].sort())
const r=await s.commands.run('id; uname -a; grep -c processor /proc/cpuinfo; free -m|head -2; ip -4 a; ip r; cat /etc/resolv.conf; for b in docker python3 curl wget tar git; do which $b||echo no-$b; done; df -h / | tail -1; cat /etc/os-release|head -2')
console.log(r.stdout, r.stderr)
console.log(s.sandboxId)
