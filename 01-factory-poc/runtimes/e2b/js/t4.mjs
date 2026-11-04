import { Sandbox } from 'e2b'
const run=async(s,c,o={})=>{try{const r=await s.commands.run(c,{timeoutMs:60000,...o});return r.stdout+r.stderr}catch(e){return 'EXIT '+e.exitCode+' '+(e.stdout||'')+(e.stderr||e.message)}}
const FAKE='FAKE-SECRET-e2b-123'
const s=await Sandbox.create('base',{timeoutMs:300000,network:{
  denyOut:['0.0.0.0/0'], allowOut:['httpbin.org','example.com'],
  rules:{'httpbin.org':[{transform:{headers:{'X-Api-Key':FAKE}}}]}}})
console.log('id',s.sandboxId)
console.log('https httpbin (rule):',await run(s,'curl -s -m10 https://httpbin.org/headers -H "X-Api-Key: PLACEHOLDER"'))
console.log('http httpbin (rule):',await run(s,'curl -s -m10 http://httpbin.org/headers'))
console.log('https example.com (allowed, no rule):',await run(s,'curl -s -m10 -o /dev/null -w "%{http_code}" -H "X-Api-Key: PLACEHOLDER" https://example.com/'))
console.log('https not allowed:',await run(s,'curl -s -m8 -o /dev/null -w "%{http_code}" -H "X-Api-Key: PLACEHOLDER" https://example.org/'))
console.log('scan:',await run(s,'env | grep -c FAKE-SECRET; sudo -n grep -rIl "FAKE-SECRET" / --exclude-dir=proc --exclude-dir=sys 2>/dev/null | head; sudo -n sh -c "cat /proc/*/environ /proc/*/cmdline 2>/dev/null | tr \\\\0 \\\\n | grep -c FAKE-SECRET"; echo done'))
console.log('ca:',await run(s,'grep -c BEGIN /etc/ssl/certs/ca-certificates.crt; curl -sv -m8 -o /dev/null https://example.com 2>&1 | grep -i "issuer"'))
await s.kill()
