#!/usr/bin/env bun
import { appendFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { matrixCaseID, matrixStart } from "./hosted-matrix.ts";

async function main() {
  const shell = process.env.GRAYBOARD_MATRIX_SHELL, observations = process.env.GRAYBOARD_MATRIX_OBSERVATIONS;
  if (!shell || !observations || !process.execve) throw new Error("Missing matrix observer");
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "tests/real-run.sh" || realpathSync(process.cwd()) !== realpathSync(process.env.GRAYBOARD_MATRIX_PACKAGE!)) {
    process.execve(shell, [shell, ...args], process.env);
    throw new Error("Shell delegation failed");
  }
  const id = matrixCaseID(process.env);
  matrixStart(observations, id);
  // Noninteractive matrix children get a group so targeted termination reaches their descendants.
  let child: ReturnType<typeof spawn> | undefined;
  const signals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
  let interrupted: NodeJS.Signals | undefined, cleanup: ReturnType<typeof setTimeout> | undefined, grace: Promise<void> | undefined;
  const forward = (signal: NodeJS.Signals) => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch {} } };
  const handlers = signals.map(signal => {
    const handler = () => {
      if (interrupted) return;
      interrupted = signal;
      forward(signal);
      // Only cancellation cleanup; normal case deadlines and execution remain untouched.
      grace = new Promise(done => { cleanup = setTimeout(() => { forward("SIGKILL"); done(); }, 1000); });
    };
    process.on(signal, handler); return handler;
  });
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise((accept, reject) => {
      child = spawn(shell, args, { env: process.env, stdio: "inherit", detached: true });
      child.once("error", () => reject(new Error("Shell launch failed")));
      child.once("exit", (code, signal) => accept({ code, signal }));
    });
    // The shell's exit doesn't end the grace (#378 6): its group's descendants keep the rest of it to clean up before
    // the SIGKILL, and the handlers stay installed meanwhile so a repeated signal can't kill this observer first.
    // A SIGKILL of the observer itself can't be handled here: the group then keeps running until its own end.
    await grace;
  } finally {
    if (cleanup) clearTimeout(cleanup);
    signals.forEach((signal, index) => process.removeListener(signal, handlers[index]!));
  }
  const signal = interrupted ?? result.signal;
  const code = signal ? 128 + constants.signals[signal] : result.code;
  if (code === null || code === undefined || code < 0 || code > 255) throw new Error("Invalid child exit");
  appendFileSync(observations, JSON.stringify({ phase: "case", id, state: "finished", exit: code }) + "\n");
  if (signal) {
    forward("SIGKILL");
    process.kill(process.pid, signal);
  } else process.exitCode = code;
}

try { await main(); } catch (error) { console.error(`Matrix observation failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
