import { Sandbox } from 'e2b'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const t0=Date.now()
const ps=await Promise.all([1,2,3].map(async()=>{const x=await Sandbox.create('base',{timeoutMs:300000});await x.commands.run('echo hi');return x}))
console.log('parallel3 create+exec s',(Date.now()-t0)/1000)
await sleep(15000)
console.log('READY-MEASURE'); await sleep(15000)
for(const x of ps) await x.kill()
console.log('killed')
