#!/usr/bin/env python3
"""Skriptovany agent: overi cestu pres LLM gateway a task API, upravi repo, spusti testy, commitne a pushne na staging."""
import json, os, subprocess, urllib.request

issue = json.load(open("/task/issue.json"))
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def task_api(path, data=None):
    req = urllib.request.Request(os.environ["TASK_API_URL"] + path, data=data,
                                 headers={"Authorization": "Bearer " + os.environ["TASK_TOKEN"]})
    return opener.open(req, timeout=60).read()


req = urllib.request.Request(
    os.environ["LLM_BASE_URL"] + "/v1/chat/completions",
    data=json.dumps({"model": "mock", "messages": [{"role": "user", "content": issue["title"]}]}).encode(),
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["LLM_API_KEY"]},
)
answer = json.load(opener.open(req, timeout=60))["choices"][0]["message"]["content"]
comments = json.loads(task_api("/task/comments"))
ci = json.loads(task_api("/task/ci"))
with open("factory-log.md", "a") as f:
    f.write(f"- #{issue['number']} {issue['title']}: {answer}\n")
subprocess.run(["python3", "-B", "tests/test_app.py"], check=True)
task_api("/task/reply", f"Hotovo, viděl jsem {len(comments['comments'])} komentářů a {len(comments['review_comments'])} review komentářů, CI: {ci['state']}.".encode())
subprocess.run(["git", "add", "-A"], check=True)
subprocess.run(["git", "-c", "user.name=agent", "-c", "user.email=agent@sandbox.invalid",
                "commit", "-qm", f"Resolve #{issue['number']}: {issue['title']}"], check=True)
# Vetev jde na staging, orchestrator ji odtamtud vezme. Fetch a rebase overuji cestu pres proxy i pri iteraci.
base, branch = os.environ["FACTORY_BASE"], os.environ["FACTORY_BRANCH"]
subprocess.run(["git", "fetch", "-q", "origin", base], check=True)
subprocess.run(["git", "-c", "user.name=agent", "-c", "user.email=agent@sandbox.invalid", "rebase", "-q", f"origin/{base}"], check=True)
subprocess.run(["git", "push", "-q", "--force", "origin", f"HEAD:refs/heads/{branch}"], check=True)
