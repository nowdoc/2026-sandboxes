// Realne LLM volani ze sandboxu pres gateway s virtualnim klicem: sudo node tests/llm_check.ts [runtime]
import * as factory from "../orchestrator/factory.ts";

const MODELS = ["GLM-5.3-Flash", "GLM-5.3"];
const PROBE = String.raw`
import json, os, sys, time, urllib.error, urllib.request
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(path, body=None):
    req = urllib.request.Request(os.environ["LLM_BASE_URL"] + path, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["LLM_API_KEY"]})
    try:
        return 200, json.load(opener.open(req, timeout=120))
    except urllib.error.HTTPError as e:
        return e.code, None
out = {"models": sorted(m["id"] for m in call("/v1/models")[1]["data"])}
for model in sys.argv[1:] + ["mock"]:
    t = time.time()
    code, r = call("/v1/chat/completions", {"model": model, "max_tokens": 200, "messages": [{"role": "user", "content": "Reply with the word OK."}]})
    out[model] = {"status": code, "seconds": round(time.time() - t, 2), "usage": r and r.get("usage"), "has_content": bool(r and r["choices"][0]["message"].get("content"))}
print(json.dumps(out))
`;

const rt = factory.RUNTIMES[process.argv[2] ?? "gvisor"]();
const sb = await rt.create("llm" + Date.now().toString(36));
const key = await factory.api("POST", "/key/generate", { max_budget: 1, duration: "10m", models: MODELS, metadata: { task: "llm-check" } }, {
  base: `http://${process.env.FACTORY_BIND ?? "127.0.0.1"}:4000`, headers: { Authorization: "Bearer " + factory.LITELLM.LITELLM_MASTER_KEY, "Content-Type": "application/json" },
}).then((r) => r.key);
sb.gatewayEnv.LLM_API_KEY = key;
try {
  const r = await rt.exec(sb, `cat > /tmp/l.py && python3 /tmp/l.py ${MODELS.join(" ")}`, Buffer.from(PROBE), 300);
  console.log(r.code ? r.stderr.toString() : r.stdout.toString());
  const info = await factory.api("GET", `/key/info?key=${encodeURIComponent(key)}`, undefined, {
    base: `http://${process.env.FACTORY_BIND ?? "127.0.0.1"}:4000`, headers: { Authorization: "Bearer " + factory.LITELLM.LITELLM_MASTER_KEY },
  });
  console.log("spend", info.info?.spend, "max_budget", info.info?.max_budget);
} finally {
  await factory.revokeKey(key);
  await rt.destroy(sb);
}
