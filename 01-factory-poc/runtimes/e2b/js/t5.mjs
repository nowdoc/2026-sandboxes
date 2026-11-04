import { Sandbox } from 'e2b'
const run=async(s,c,o={})=>{try{const r=await s.commands.run(c,{timeoutMs:60000,...o});return r.stdout+r.stderr}catch(e){return 'EXIT '+e.exitCode+' '+(e.stdout||'')+(e.stderr||e.message)}}
const mk=()=>Sandbox.create('base',{timeoutMs:300000,network:{denyOut:['0.0.0.0/0'],allowOut:['198.18.0.10/32']}})
const a=await mk(), b=await mk()
for (const [n,s] of [['A',a],['B',b]]){
  console.log(n,s.sandboxId,(await run(s,'ip -4 -o a show eth0')).trim())
  console.log(n,'->198.18.0.10:18099',await run(s,'curl -s -m6 http://198.18.0.10:18099/from'+n))
}
console.log('A->B ping/tcp', await run(a,'curl -s -m4 http://169.254.0.21:49983/health -o /dev/null -w "%{http_code}"; ping -c1 -W2 10.11.0.2 2>&1 | tail -2'))
await a.kill(); await b.kill()
