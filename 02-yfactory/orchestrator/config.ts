import fs from "node:fs";
import path from "node:path";
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing variable ${name}`);
  return v;
}

const env = (name: string, def: string) => process.env[name] || def;
const config = env("YF_CONFIG", "/config");
const json = (file: string) => JSON.parse(fs.readFileSync(path.join(config, file), "utf8"));
// config/yfactory.json: limits. The models agents may use are those of the LiteLLM provider in opencode.json.
const settings = { maxRunning: 3, runTimeout: 1800, ...json("yfactory.json") };

export const CFG = {
  data: env("YF_DATA", "/data"),
  // Environments and repositories are edited in the UI, so they are state and live in the data volume; providers are in config.
  projects: path.join(env("YF_DATA", "/data"), "projects"),
  config,
  litellm: { url: env("LITELLM_URL", "http://litellm:4000"), masterKey: need("LITELLM_MASTER_KEY"), models: Object.keys(json("opencode.json").provider.litellm.models) },
  s3: { endpoint: env("S3_ENDPOINT", "http://garage:3900"), region: env("S3_REGION", "garage"), bucket: env("S3_BUCKET", "yfactory"), accessKey: need("S3_ACCESS_KEY"), secretKey: need("S3_SECRET_KEY") },
  sandbox: {
    url: env("YF_SANDBOX_URL", "http://sandbox:7000"),
    token: need("SANDBOX_TOKEN"),
    api: env("YF_API_IP", "10.99.0.10"),
    proxy: env("YF_PROXY_IP", "10.99.0.11"),
  },
  // The host port of the IDE listener (yfactory :8081), for the links the UI opens.
  idePort: Number(env("YF_IDE_PORT", "8092")),
  maxRunning: Number(settings.maxRunning),
  maxSandboxes: Number(env("YF_MAX_SANDBOXES", "6")),
  runTimeout: Number(settings.runTimeout),
  setupTimeout: Number(env("YF_SETUP_TIMEOUT", "1200")),
};
