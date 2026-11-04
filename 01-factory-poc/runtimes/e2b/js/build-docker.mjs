import { Template } from 'e2b'
const t=Template().fromUbuntuImage('24.04').runCmd('apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io docker-compose-v2 iptables curl ca-certificates && apt-get clean',{user:'root'})
const t0=Date.now()
await Template.build(t,'e2b-docker',{memoryMB:1536,cpuCount:4,onBuildLogs:(e)=>console.log(String(e).slice(0,200))})
console.log('BUILD DONE',(Date.now()-t0)/1000)
