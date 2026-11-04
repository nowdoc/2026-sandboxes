import { Sandbox } from 'e2b'
import { readFileSync } from 'node:fs'
const run=async(s,c,o={})=>{try{const r=await s.commands.run(c,{timeoutMs:600000,user:'root',...o});return r.stdout+r.stderr}catch(e){return 'EXIT '+e.exitCode+' '+(e.stdout||'')+(e.stderr||e.message)}}
const s=await Sandbox.create('e2b-docker',{timeoutMs:900000})
await run(s,'mkdir -p /fixture/src')
await s.files.write('/tmp/compose.yml',readFileSync('/app/js/fixture-compose.yml','utf8'))
await s.files.write('/tmp/app.py',readFileSync('/app/js/fsrc/app.py','utf8'))
await run(s,'cp /tmp/compose.yml /fixture/compose.yml; cp /tmp/app.py /fixture/src/app.py')
console.log(await run(s,'systemctl is-active docker; docker info 2>&1 | grep -E "Storage Driver|Cgroup|Server Version|Runtimes"; df -h / | tail -1; docker images --format "{{.Repository}}:{{.Tag}} {{.Size}}"'))
const t=Date.now()
console.log(await run(s,'cd /fixture && docker compose up -d --wait --wait-timeout 240 2>&1 | tail -3; echo healthy=$(docker compose ps --format "{{.Health}}" | grep -c healthy)/15'))
console.log('up secs',(Date.now()-t)/1000)
console.log('NSLOOKUP:',await run(s,'cd /fixture && docker compose exec -T web nslookup web.cz.test 172.30.0.2 2>&1; echo rc=$?'))
console.log('egress from container:',await run(s,'docker exec fixture-web-1 wget -qO- -T4 http://example.com | head -c 80'))
await s.kill()
