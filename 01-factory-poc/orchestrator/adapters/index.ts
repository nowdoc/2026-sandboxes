import type { Result } from "../proc.ts";
import { DockerRuntime } from "./docker.ts";
import { MicrosandboxRuntime } from "./microsandbox.ts";
import { SbxRuntime } from "./sbx.ts";
import { E2BRuntime } from "./e2b.ts";

export type Sandbox = {
  id: string;
  ip: string; // adresa, pod kterou sandbox vidi gateway
  gatewayEnv: Record<string, string>;
};

// Jediny kontrakt, ktery musi runtime splnit. upload/download staci postavit nad exec.
export interface SandboxRuntime {
  runtime: string;
  create(taskId: string): Promise<Sandbox>;
  exec(sb: Sandbox, cmd: string, stdin?: Buffer, timeout?: number): Promise<Result>;
  destroy(sb: Sandbox): Promise<void>;
  cleanup?(): Promise<void>; // po restartu: smaze sandboxy s prefixem factory-task-
}

// Jen runtimes s TS adapterem a E2E do PR; UI nabizi presne tyto.
export const RUNTIMES: Record<string, () => SandboxRuntime> = {
  runc: () => new DockerRuntime("runc"),
  gvisor: () => new DockerRuntime("runsc"),
  microsandbox: () => new MicrosandboxRuntime(),
  sbx: () => new SbxRuntime(),
  e2b: () => new E2BRuntime(),
};

// Kandidati bez plneho E2E, iterace a security bez selhani. Spusti je jen FACTORY_RUNTIME nebo security.ts,
// do UI jdou jen pres FACTORY_CANDIDATES (zkouska), jinak az po presunu do RUNTIMES.
export const CANDIDATES: Record<string, () => SandboxRuntime> = {};
