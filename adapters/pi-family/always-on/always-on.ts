// An always-on hosted pi (#631): one pi in RPC mode with stdin held open, so
// grayboard's pushes have a live session to wake (`pi -p` exits after one
// message). Plain Node runs it as is: type stripping, no dependencies. A
// supervisor restarts it when it exits, and it exits with pi's status.
//
// It never prompts the agent. --handle goes in pi's BUS_IDENTITY, which the
// hosted extension binds at a session's first start, creating it if new, and
// a continued session takes back the names it held (#443). Signed out, it
// sends pi the extension's own `/grayboard login`, which the extension
// handles without a model turn, so the sign-in link reaches the log; once
// it's approved, the extension's own restart binds the handle.
//
// The agent has a directory of its own: `<dir>/agent` is its
// PI_CODING_AGENT_DIR (the hosted extension, its config.json and grant, any
// mcp.json) and `<dir>/sessions` its session directory. A shared ~/.pi/agent
// would hand its MCP servers and its sign-in to every other pi on the
// machine: --tools keeps MCP tools unless an entry starts with mcp__.
// docs/guide/harnesses.md §Always-on pi.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = "usage: always-on.ts --handle <name> --dir <agent dir> [--agent-dir <dir>] [--cwd <dir>] [--pi <pi>] [-- <pi arguments>]";
// What bind takes (src/shared/addressing.ts).
const HANDLE = /^[a-z0-9_-]{1,32}$/;
// Dialogs block pi until a client answers, and nobody is there to.
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
// The extension's notice for a session that starts signed out (hosted-core
// AccessExpired with pi's login action).
export const SIGNED_OUT = "grayboard: Signed out of grayboard in pi; run /grayboard login";

export type Options = { handle: string; dir: string; agentDir: string; cwd: string; pi: string; piArgs: string[] };
export type Log = (line: string) => void;

export function parse(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { handle: { type: "string" }, dir: { type: "string" }, "agent-dir": { type: "string" }, cwd: { type: "string" }, pi: { type: "string" } },
  });
  const { handle, dir } = values;
  if (!handle || !dir) throw new Error(USAGE);
  if (!HANDLE.test(handle)) throw new Error(`--handle ${JSON.stringify(handle)}: a handle is 1 to 32 of a-z, 0-9, _ and -`);
  const root = resolve(dir);
  return {
    handle,
    dir: root,
    agentDir: resolve(values["agent-dir"] ?? join(root, "agent")),
    cwd: resolve(values.cwd ?? join(root, "workspace")),
    pi: values.pi ?? "pi",
    piArgs: positionals,
  };
}

/** pi's arguments: RPC mode on the agent's session directory, continuing its latest session once there is one. */
export function piArgs(o: Options): string[] {
  const sessions = join(o.dir, "sessions");
  const resume = readdirSync(sessions).length > 0;
  return ["--mode", "rpc", "--session-dir", sessions, ...(resume ? ["--continue"] : []), ...o.piArgs];
}

const stamped: Log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const clip = (text: unknown, n = 300): string => {
  const s = String(text ?? "").replace(/\s+/g, " ");
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** Runs pi until it exits. Resolves with the status a supervisor should see: pi's, or 0 after a stop. */
export function run(o: Options, log: Log = stamped): Promise<number> {
  for (const d of [join(o.dir, "sessions"), o.agentDir, o.cwd]) mkdirSync(d, { recursive: true });
  const args = piArgs(o);
  const child = spawn(o.pi, args, {
    cwd: o.cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: o.agentDir, BUS_IDENTITY: o.handle },
    stdio: ["pipe", "pipe", "inherit"],
  });
  // A pi that died mid-write is reported by its exit, not here.
  child.stdin.on("error", () => {});
  const send = (record: Record<string, unknown>) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(record)}\n`);
  };
  let stopping = false;
  // A supervisor's stop: closing pi's stdin asks it to shut down in order. Not
  // a signal of our own: a supervisor that signals the whole group (systemd's
  // default, a terminal's Ctrl-C) already sent pi one, and a second makes pi
  // exit at once, while stdin's end beside a signal is safe. A second signal
  // ends the runner at once.
  const stop = () => {
    stopping = true;
    child.stdin.end();
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, stop);

  child.once("spawn", () => {
    log(`started pi (pid ${child.pid}) as ${o.handle}${args.includes("--continue") ? ", continuing its session" : ""}`);
  });

  const onRecord = (line: string) => {
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    switch (e.type) {
      case "extension_ui_request":
        if (DIALOGS.has(e.method)) {
          send({ type: "extension_ui_response", id: e.id, cancelled: true });
          log(`declined ${e.method}: ${clip(e.title ?? e.message)}`);
        } else if (e.method === "notify") {
          // The sign-in link arrives here, as `grayboard: sign in at <url>`.
          log(`notice: ${clip(e.message, 2000)}`);
          // The extension's own command, handled without a model turn.
          if (e.message === SIGNED_OUT) {
            send({ type: "prompt", message: "/grayboard login" });
            log("signed out: asked the extension for a sign-in link (/grayboard login)");
          }
        }
        break;
      case "response":
        if (e.success === false) log(`${e.command} failed: ${clip(e.error)}`);
        break;
      case "tool_execution_start":
        log(`tool ${e.toolName}`);
        break;
      case "turn_end": {
        const content: unknown[] = Array.isArray(e.message?.content) ? e.message.content : [];
        const text = content.map((c) => (c as { text?: unknown })?.text ?? "").join("");
        log(`turn end: ${clip(text, 120)}`);
        break;
      }
      case "error":
      case "extension_error":
        log(`${e.type}: ${clip(JSON.stringify(e))}`);
        break;
    }
  };
  // pi's framing: one record per LF, an optional CR before it, nothing else a boundary.
  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      onRecord(line);
    }
  });

  return new Promise((done) => {
    child.once("error", (e) => {
      log(`couldn't start ${o.pi}: ${e.message}`);
      done(127);
    });
    child.once("exit", (code, signal) => {
      log(`pi exited ${signal ?? code}`);
      done(stopping ? 0 : code ?? 128 + (signal ? constants.signals[signal] : 0));
    });
  });
}

// Run, not imported: by real path, since a checkout reached through a symlink
// (macOS's /tmp is one) names this file differently in argv and import.meta.
const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  let options: Options;
  try {
    options = parse(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  run(options).then((code) => process.exit(code));
}
