import { Sandbox } from 'e2b'
import { readFileSync } from 'node:fs'
const HOST = process.env.FACTORY_HOST || '127.0.0.1'
const run=async(s,c,o={})=>{try{const r=await s.commands.run(c,{timeoutMs:60000,...o});return r.stdout+r.stderr}catch(e){return 'EXIT '+e.exitCode+' '+(e.stdout||'')+(e.stderr||e.message)}}
const probe=readFileSync('/app/js/probe.py','utf8')
const env='LLM_BASE_URL=http://172.18.0.4:4000 HTTPS_PROXY=http://172.18.0.2:3128 HTTP_PROXY=http://172.18.0.2:3128 NO_PROXY=172.18.0.4'
async function scenario(name,network){
  console.log('=====',name,JSON.stringify(network))
  let s
  try{ s=await Sandbox.create('base',{timeoutMs:300000,network}) }catch(e){console.log('CREATE FAIL',e.message);return}
  await s.files.write('/tmp/probe.py',probe)
  console.log(await run(s,env+' python3 /tmp/probe.py'))
  for (const [n,c] of [
   ['ip1.1.1.1 https','curl -s -m5 -o /dev/null -w "%{http_code}" https://1.1.1.1/'],
   ['example.com https','curl -s -m5 -o /dev/null -w "%{http_code}" https://example.com/'],
   ['example.com dns','getent hosts example.com | head -1'],
   ['metadata','curl -s -m4 -o /dev/null -w "%{http_code}" http://169.254.169.254/'],
   ['lan router','curl -s -m4 -o /dev/null -w "%{http_code}" http://192.168.1.1/'],
   ['host:22',`timeout 4 bash -c "echo | nc -w3 ${HOST} 22 || cat </dev/null >/dev/tcp/${HOST}/22 && echo open"`],
   ['host echo 18099',`curl -s -m5 http://${HOST}:18099/t`],
   ['llm-gw','curl -s -m5 -o /dev/null -w "%{http_code}" http://172.18.0.4:4000/health'],
   ['pkg-gw','curl -s -m6 -x http://172.18.0.2:3128 -o /dev/null -w "%{http_code}" https://pypi.org/simple/pip/'],
  ]) console.log('--',n,':',(await run(s,c)).trim().slice(0,200))
  await s.kill()
}
await scenario('default',undefined)
await scenario('deny all',{denyOut:['0.0.0.0/0']})
await scenario('deny all + allow host/gw',{denyOut:['0.0.0.0/0'],allowOut:[`${HOST}/32`,'172.18.0.4/32','172.18.0.2/32']})
await scenario('deny all + allow domains',{denyOut:['0.0.0.0/0'],allowOut:['pypi.org','files.pythonhosted.org','example.org']})
