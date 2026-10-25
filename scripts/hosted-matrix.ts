import { appendFileSync, readFileSync } from "node:fs";

export const matrixLoopSHA = "daecaf67fd934d1b37c5fe6eec8df58311388c7f77c897bf3325d9d04cb5811a";

export const matrixCases = [
  ...["pause", "archive", "delete", "rebind", "enrollment", "account", "account-away-back", "config", "away-back", "revocation", "expiry"].flatMap(scenario => ["before", "after"].map(boundary => ({ scenario, boundary, crash: "" }))),
  ...["outage", "digest-reload", "native-refresh", "admission", "admission-account"].map(scenario => ({ scenario, boundary: "", crash: "" })),
  ...["before", "after"].map(crash => ({ scenario: "", boundary: "", crash })),
];

export function matrixCaseID(env: NodeJS.ProcessEnv): number {
  const index = matrixCases.findIndex(c => c.scenario === (env.GRAYBOARD_TEST_REAL_RACE ?? "") && c.boundary === (env.GRAYBOARD_TEST_RACE_BOUNDARY ?? "") && c.crash === (env.GRAYBOARD_TEST_CRASH_BOUNDARY ?? ""));
  if (index < 0) throw new Error("Invalid matrix invocation");
  return index + 1;
}

export function matrixStart(path: string, id: number) {
  if (id === 1) appendFileSync(path, '{"phase":"prepare","state":"finished","exit":0}\n');
  appendFileSync(path, JSON.stringify({ phase: "case", id, state: "started" }) + "\n");
}

// Exact canonical records reject extra keys, duplicate keys and secret-bearing arbitrary strings.
export function matrixObservation(raw: string, runtimeExit: number) {
  const invalid = (): never => { throw new Error("Invalid matrix observations"); };
  if (Buffer.byteLength(raw) > 8192 || !raw.endsWith("\n") || !Number.isInteger(runtimeExit) || runtimeExit < 0 || runtimeExit > 255) invalid();
  const lines = raw.slice(0, -1).split("\n");
  if (lines.length > 60 || lines[0] !== '{"phase":"prepare","state":"started"}') invalid();
  let offset = 1;
  const cases: { id: number; exit: number }[] = [];
  let phase: "prepare" | "case" | "complete" = "prepare", state: "interrupted" | "finished" = "interrupted", id: number | undefined, exit = runtimeExit;
  if (lines.length > 1) {
    if (lines[offset++] !== '{"phase":"prepare","state":"finished","exit":0}') invalid();
    state = "finished"; exit = 0;
    for (let next = 1; offset < lines.length; next++) {
      if (next > matrixCases.length || lines[offset++] !== JSON.stringify({ phase: "case", id: next, state: "started" })) invalid();
      phase = "case"; id = next; state = "interrupted"; exit = runtimeExit;
      if (offset === lines.length) break;
      let value: any;
      try { value = JSON.parse(lines[offset++]!); } catch { invalid(); }
      if (!Number.isInteger(value?.exit) || value.exit < 0 || value.exit > 255 || lines[offset - 1] !== JSON.stringify({ phase: "case", id: next, state: "finished", exit: value.exit })) invalid();
      exit = value.exit; state = "finished"; cases.push({ id: next, exit });
      if (exit !== 0 && offset !== lines.length) invalid();
    }
  }
  if (cases.length === matrixCases.length && exit === 0) { phase = "complete"; id = undefined; }
  if (runtimeExit === 0 && (phase !== "complete" || cases.some(c => c.exit !== 0))) invalid();
  return { phase, ...(id === undefined ? {} : { id }), state, exit, completed: cases.length, cases };
}

if (import.meta.main) {
  try {
    const bytes = readFileSync(process.argv[2]!);
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== matrixLoopSHA) throw new Error("Unknown matrix loop");
  } catch { console.error("Matrix loop not reviewed; private diagnostics withheld"); process.exitCode = 1; }
}
