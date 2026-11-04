import { Sandbox } from 'e2b'
import { readFileSync } from 'node:fs'
const run=async(s,c)=>{try{const r=await s.commands.run(c,{timeoutMs:240000});return r.stdout+r.stderr}catch(e){return 'EXIT '+e.exitCode+' '+(e.stdout||'')+(e.stderr||e.message)}}
const probe=readFileSync('/app/js/probe.py','utf8')
for (const [name,network] of [['default',undefined],['deny0/0+allow pypi',{denyOut:['0.0.0.0/0'],allowOut:['pypi.org','files.pythonhosted.org']}]]){
  const s=await Sandbox.create('base',{timeoutMs:600000,network}); await s.files.write('/tmp/probe.py',probe)
  console.log('==',name,(await run(s,'python3 /tmp/probe.py')).trim())
  console.log('   pip index via direct allowed domain:',(await run(s,'curl -s -m8 -o /dev/null -w "%{http_code}" https://pypi.org/simple/pip/')).trim())
  console.log('   metadata (MMDS) body:',(await run(s,'curl -s -m3 http://169.254.169.254/ | head -c 150')).trim())
  await s.kill()
}
