import { Sandbox } from 'e2b'
import { readFileSync } from 'node:fs'
const HOST = process.env.FACTORY_HOST || '127.0.0.1'
const run=async(s,c,o={})=>{try{const r=await s.commands.run(c,{timeoutMs:120000,...o});return r.stdout+r.stderr}catch(e){return 'EXIT '+e.exitCode+' '+(e.stdout||'')+(e.stderr||e.message)}}
const s=await Sandbox.create('base',{timeoutMs:600000})
console.log('id',s.sandboxId)
await s.files.write('/tmp/probe.py',readFileSync('/app/js/probe.py','utf8'))
const env='LLM_BASE_URL=http://172.18.0.4:4000 HTTPS_PROXY=http://172.18.0.2:3128 HTTP_PROXY=http://172.18.0.2:3128 NO_PROXY=172.18.0.4'
console.log('PROBE(default egress):',await run(s,env+' python3 /tmp/probe.py'))
console.log('echo host:',await run(s,`curl -s -m5 http://${HOST}:18099/direct -H "X-T: 1"`))
console.log('dns:',await run(s,'getent hosts example.com; curl -s -m5 -o /dev/null -w "%{http_code}\\n" https://example.com'))
console.log('gw llm:',await run(s,'curl -s -m5 -o /dev/null -w "%{http_code}\\n" http://172.18.0.4:4000/health; curl -s -m5 -x http://172.18.0.2:3128 -o /dev/null -w "%{http_code}\\n" https://pypi.org/simple/pip/'))
await s.kill()
