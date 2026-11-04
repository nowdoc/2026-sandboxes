import { Sandbox } from 'e2b'
const run=async(s,c,o={})=>{try{const r=await s.commands.run(c,{timeoutMs:60000,...o});return r.stdout+r.stderr}catch(e){return 'EXIT '+e.exitCode+' '+(e.stdout||'')+(e.stderr||e.message)}}
const s=await Sandbox.create('base',{timeoutMs:300000})
console.log(await run(s,'(zcat /proc/config.gz 2>/dev/null || cat /boot/config* 2>/dev/null) | grep -E "CONFIG_(OVERLAY_FS|BRIDGE|VETH|NETFILTER_XT_MATCH_ADDRTYPE|NF_NAT|IP_NF_NAT|NF_TABLES|IP6_NF|NETFILTER_XT_TARGET_MASQUERADE|CGROUP_PIDS|CGROUP_DEVICES|USER_NS|NAMESPACES|MODULES|BRIDGE_NETFILTER|NETFILTER_XT_MATCH_CONNTRACK)=" ; ls /proc/config.gz; lsmod | head; cat /proc/filesystems | tr "\\n" " "; df -h / ; sudo -n id'))
console.log(await run(s,'sudo mkdir -p /x && echo ok; mount | grep cgroup | head -3; apt-get --version | head -1'))
await s.kill()
