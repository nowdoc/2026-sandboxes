import { Sandbox } from 'e2b'
import { readFileSync } from 'node:fs'
const run=async(s,c,o={})=>{try{const r=await s.commands.run(c,{timeoutMs:600000,...o});return r.stdout+r.stderr}catch(e){return 'EXIT '+e.exitCode+' '+(e.stdout||'')+(e.stderr||e.message)}}
let t=Date.now()
const s=await Sandbox.create('e2b-docker',{timeoutMs:900000})
console.log('create+',(Date.now()-t)/1000, s.sandboxId)
console.log(await run(s,'id; nproc; free -m|sed -n 2p; df -h /|tail -1; docker --version; docker compose version; cat /proc/sys/net/ipv4/ip_forward'))
await run(s,'mkdir -p /fixture/src',{user:'root'})
await s.files.write('/tmp/compose.yml',readFileSync('/app/js/fixture-compose.yml','utf8'))
await s.files.write('/tmp/app.py',readFileSync('/app/js/fsrc/app.py','utf8'))
await s.files.write('/tmp/compose_probe.sh',readFileSync('/app/js/compose_probe.sh','utf8'))
await run(s,'cp /tmp/compose.yml /fixture/compose.yml; cp /tmp/app.py /fixture/src/app.py',{user:'root'})
t=Date.now()
console.log('PROBE:',await run(s,'sh /tmp/compose_probe.sh',{user:'root',timeoutMs:600000}))
console.log('probe wall',(Date.now()-t)/1000)
console.log(await run(s,'docker ps --format "{{.Names}} {{.Status}}" | head -20; docker compose -f /fixture/compose.yml ps --format "{{.Name}} {{.Health}}" | head -20; free -m | sed -n 2p; tail -5 /tmp/dockerd.log',{user:'root'}))
await s.kill()
