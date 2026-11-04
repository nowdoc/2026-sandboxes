// Prometheus text format without a client library. Counters live in memory and reset on restart.
export type Labels = Record<string, string | number>;
export type Sample = [name: string, labels: Labels, value: number];

const counters = new Map<string, Sample>();
const fmt = (l: Labels) => {
  const e = Object.entries(l);
  return e.length ? `{${e.map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, "_")}"`).join(",")}}` : "";
};

export function inc(name: string, labels: Labels = {}, by = 1) {
  const k = name + fmt(labels);
  const c = counters.get(k) ?? counters.set(k, [name, labels, 0]).get(k)!;
  c[2] += by;
}

export const render = (gauges: Sample[] = []) =>
  [...counters.values(), ...gauges].map(([n, l, v]) => `${n}${fmt(l)} ${v}`).sort().join("\n") + "\n";
