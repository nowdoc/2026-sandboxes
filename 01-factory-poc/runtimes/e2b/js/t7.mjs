import { Sandbox } from 'e2b'
import { execSync } from 'node:child_process'
const run=async(s,c,o={})=>{try{const r=await s.commands.run(c,{timeoutMs:60000,...o});return r.stdout+r.stderr}catch(e){return 'EXIT '+e.exitCode+' '+(e.stdout||'')+(e.stderr||e.message)}}
// tar via stdin
const s=await Sandbox.create('base',{timeoutMs:600000})
const h=await s.commands.run('mkdir -p /tmp/in && tar xf - -C /tmp/in && ls -la /tmp/in',{background:true,stdin:true,timeoutMs:60000})
// build tar in-process (ustar, one file)
function tarOf(name,content){const b=Buffer.alloc(512);b.write(name,0);b.write('0000644\0',100);b.write('0000000\0',108);b.write('0000000\0',116);b.write(content.length.toString(8).padStart(11,'0')+'\0',124);b.write('00000000000\0',136);b.write('        ',148);b.write('0',156);b.write('ustar\0',257);b.write('00',263);let sum=0;for(const x of b)sum+=x;b.write(sum.toString(8).padStart(6,'0')+'\0 ',148);const d=Buffer.alloc(Math.ceil(content.length/512)*512);d.write(content);return Buffer.concat([b,d,Buffer.alloc(1024)])}
await h.sendStdin?.(tarOf('hello.txt','tar-over-stdin ok\n').toString('binary')).catch?.(e=>console.log('sendStdin err',e.message))
await s.commands.closeStdin?.(h.pid)
const r=await h.wait().catch(e=>e); console.log('TAR stdin:',r.exitCode, r.stdout||r.message, r.stderr||'')
console.log('cat:',await run(s,'cat /tmp/in/hello.txt'))
// isolation: files
await run(s,'echo SECRETA > /tmp/onlyA')
const s2=await Sandbox.create('base',{timeoutMs:600000})
console.log('B sees A file?',await run(s2,'ls /tmp/onlyA 2>&1; cat /proc/sys/kernel/random/boot_id'), await run(s,'cat /proc/sys/kernel/random/boot_id'))
console.log('A ip/B ip', (await run(s,'ip -4 -o a show eth0')).trim().slice(0,60), (await run(s2,'ip -4 -o a show eth0')).trim().slice(0,60))
console.log('A->B tcp via 10.12/ 169.254.0.x:',await run(s,'for h in 169.254.0.22 10.11.0.1 10.12.0.1; do echo $h; curl -s -m2 -o /dev/null -w "%{http_code}\\n" http://$h:49983/health; done'))
// lifecycle: pause/resume
await run(s,'echo state-kept > /tmp/f; (sleep 1000 &) ; echo bg started')
const t=Date.now(); const ok=await Sandbox.pause(s.sandboxId); console.log('pause',ok,(Date.now()-t)/1000)
const t2=Date.now(); const s3=await Sandbox.connect(s.sandboxId,{timeoutMs:600000}); console.log('resume',(Date.now()-t2)/1000, await run(s3,'cat /tmp/f; pgrep -c sleep'))
// parallel 3
const t3=Date.now(); const ps=await Promise.all([1,2,3].map(()=>Sandbox.create('base',{timeoutMs:300000}).then(async x=>{await x.commands.run('echo');return x})))
console.log('parallel3 create+exec',(Date.now()-t3)/1000)
console.log('running list',(await Sandbox.list().nextItems()).length)
// host RAM view with 6 sandboxes
console.log(execSync('true').toString())
console.log('IDS', [s.sandboxId,s2.sandboxId,...ps.map(p=>p.sandboxId)].join(','))
await new Promise(r=>setTimeout(r,20000))
for (const x of [s3,s2,...ps]) await x.kill()
