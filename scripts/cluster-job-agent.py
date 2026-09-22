#!/usr/bin/env python3
"""Portable Curt Cluster job agent for Termux, Linux, Steam Deck and Windows."""
import hashlib, json, os, platform, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

API=os.getenv("CLUSTER_JOBS_URL","https://curtbrag.com/api/jobs")
KEY=os.getenv("CLUSTER_API_KEY","")
NODE=os.getenv("CLUSTER_NODE",platform.node())
POLL=max(5,int(os.getenv("CLUSTER_JOB_POLL","10")))

def call(action,data):
    req=urllib.request.Request(API+"?action="+action,data=json.dumps(data).encode(),headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=30) as r:return json.loads(r.read())
def report(action,jid,**extra):
    payload={"jobId":jid,"node":NODE};payload.update(extra);return call(action,payload)
def run(cmd,timeout=7200):
    p=subprocess.run(cmd,capture_output=True,text=True,timeout=timeout)
    out=(p.stdout+"\n"+p.stderr).strip()
    if p.returncode:raise RuntimeError(out[-3000:] or "command failed")
    return out[-12000:]
def required(name):
    p=shutil.which(name)
    if not p:raise RuntimeError(name+" is not installed on "+NODE)
    return p
def safe_path(value):
    p=Path(os.path.expandvars(os.path.expanduser(value))).resolve()
    if str(p) in ("/",str(Path.home().anchor)):raise RuntimeError("refusing broad root path")
    return p
def execute(job):
    t=job["type"]; inp=job.get("input") or {}; src=inp.get("source",""); dst=inp.get("destination","")
    if t=="health-audit":
        return json.dumps({"node":NODE,"platform":platform.platform(),"python":sys.version.split()[0],"cpu_count":os.cpu_count(),"disk":shutil.disk_usage(Path.home())._asdict()},indent=2)
    if t=="inventory":
        root=safe_path(src); files=[p for p in root.rglob("*") if p.is_file()]
        return json.dumps({"path":str(root),"files":len(files),"bytes":sum(p.stat().st_size for p in files),"extensions":sorted({p.suffix.lower() for p in files if p.suffix})[:100]},indent=2)
    if t=="checksum":
        root=safe_path(src); paths=[root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]
        lines=[]
        for p in paths:
            h=hashlib.sha256()
            with p.open("rb") as f:
                for block in iter(lambda:f.read(1024*1024),b""):h.update(block)
            lines.append(h.hexdigest()+"  "+str(p))
        return "\n".join(lines)[-12000:]
    if t=="archive":
        source=safe_path(src); dest=safe_path(dst)
        dest.parent.mkdir(parents=True,exist_ok=True)
        return run([required("tar"),"-czf",str(dest),"-C",str(source.parent),source.name])
    if t=="backup":
        source=safe_path(src); dest=safe_path(dst); dest.mkdir(parents=True,exist_ok=True)
        return run([required("rsync"),"-a","--delete-delay",str(source)+os.sep,str(dest)+os.sep])
    if t=="download":
        dest=safe_path(dst); dest.mkdir(parents=True,exist_ok=True)
        return run([required("yt-dlp"),"--no-playlist","-o",str(dest/"%(title)s.%(ext)s"),src])
    if t=="media-probe":
        return run([required("ffprobe"),"-v","error","-show_format","-show_streams","-of","json",str(safe_path(src))])
    if t=="media-convert":
        source=safe_path(src); dest=safe_path(dst); dest.parent.mkdir(parents=True,exist_ok=True)
        return run([required("ffmpeg"),"-y","-i",str(source),str(dest)])
    if t=="transcribe":
        source=safe_path(src); dest=safe_path(dst); dest.mkdir(parents=True,exist_ok=True)
        return run([required("whisper"),str(source),"--output_dir",str(dest),"--output_format","all"])
    raise RuntimeError("unsupported workload: "+t)
def main():
    if not KEY:raise SystemExit("Set CLUSTER_API_KEY")
    print("Curt Cluster job agent:",NODE,API,flush=True)
    while True:
        try:
            data=call("claim",{"node":NODE}); job=data.get("job")
            if not job:time.sleep(POLL);continue
            jid=job["id"];report("progress",jid,progress=5,message="Started "+job["type"])
            try:report("complete",jid,output=execute(job))
            except Exception as e:report("fail",jid,error=str(e))
        except KeyboardInterrupt:return
        except Exception as e:print("agent error:",e,flush=True);time.sleep(POLL)
if __name__=="__main__":main()
