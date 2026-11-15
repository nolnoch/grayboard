// Scenarios (#926): "this tool call, from this state, gives this result", stated once and run under every driver.
// A scenario tagged with `modes` runs only there; every skip is printed, so a missing cell shows.
import { afterAll, describe, expect, test } from "bun:test";
import { DRIVERS, type Bus, type Driver, type Mode, type Outcome, type Peer } from "./driver.ts";

export type Context = {
  mode: Mode;
  bus: Bus;
  // Peers by bare handle, started in the order the scenario lists them.
  peers: Record<string, Peer>;
  // A success's value; a refusal fails the scenario with the mode's text.
  ok(o: Outcome): any;
  // A refusal. `code` is asserted where the mode reports a code; where it reports none, the gap is recorded and
  // printed. A scenario proves the refusal had no effect with a follow-up read, never by its wording.
  refused(o: Outcome, code?: string): void;
};

export type Scenario = { name: string; peers: string[]; modes?: Mode[]; why?: string; run(ctx: Context): Promise<void> };

export function conformance(family: string, scenarios: Scenario[]): void {
  const skips: string[] = [];
  const gaps = new Set<string>();
  // Printed after the family's runs, so a skipped or code-less cell is visible in the test output.
  afterAll(() => {
    if (skips.length) console.log(`conformance ${family}: skipped cells\n  ${skips.join("\n  ")}`);
    if (gaps.size) console.log(`conformance ${family}: refusal-code gaps\n  ${[...gaps].join("\n  ")}`);
  });
  for (const make of DRIVERS) {
    const driver: Driver = make();
    describe(`${family} [${driver.mode}]`, () => {
      afterAll(() => driver.stop());
      for (const s of scenarios) {
        if (s.modes && !s.modes.includes(driver.mode)) {
          skips.push(`${family} [${driver.mode}] ${s.name}: ${s.modes.join("/")} only${s.why ? ` (${s.why})` : ""}`);
          test.skip(s.name, () => {});
          continue;
        }
        test(s.name, async () => {
          const bus = await driver.bus();
          try {
            const peers: Record<string, Peer> = {};
            for (const name of s.peers) peers[name] = await bus.peer(name);
            await s.run({
              mode: driver.mode, bus, peers,
              ok(o) {
                if (!o.ok) throw new Error(`expected success, got refusal${o.code ? ` (${o.code})` : ""}: ${o.text}`);
                return o.value;
              },
              refused(o, code) {
                if (o.ok) throw new Error(`expected a refusal, got ${JSON.stringify(o.value)}`);
                if (code === undefined) return;
                if (o.code === undefined) gaps.add(`${driver.mode}: no refusal code (${family}: ${s.name} expects ${code})`);
                else expect(o.code).toBe(code);
              },
            });
          } finally {
            await bus.close();
          }
        }, 30_000);
      }
    });
  }
}
