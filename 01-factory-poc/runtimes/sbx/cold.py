import os,subprocess,time,statistics,sys
WS=os.path.join(os.path.dirname(os.path.abspath(__file__)), "ws")
def sbx(*a,inp=None):
    return subprocess.run(["sg","kvm","-c"," ".join(["sbx",*a])],capture_output=True,input=inp,text=True)
res=[]
for i in range(3):
    n=f"sbx-cold{i}"
    t=time.time(); r=sbx("create","--name",n,"shell",WS); t1=time.time()
    e=sbx("exec",n,"echo","hi"); t2=time.time()
    res.append((t1-t,t2-t1,t2-t)); print(n,r.returncode,e.stdout.strip(),res[-1],flush=True)
    if i==2:
        time.sleep(15)
        print(subprocess.run("ps -eo rss,args | grep -E 'nerdbox|sandboxd|sbx|libkrun|qemu' | grep -v grep | cut -c1-150",shell=True,capture_output=True,text=True).stdout)
    else: sbx("rm","--force",n)
print("median total",statistics.median(x[2] for x in res))
