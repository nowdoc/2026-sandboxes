import { Sandbox } from 'e2b'
const p=Sandbox.list(); let n=0
while(p.hasNext){ for(const x of await p.nextItems()){ await Sandbox.kill(x.sandboxId); n++ } }
console.log('killed',n)
