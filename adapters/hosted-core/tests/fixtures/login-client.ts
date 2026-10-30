// A Login in its own process, for the cross-process tests in
// tests/integration/hosted_core_login.test.ts:
// `bun login-client.ts token | login | token-loop <ms>` with GB_LOGIN_CONFIG
// = {resource, clientId, stateDir}. Prints one JSON line per event.
import { Login } from "../../src/login.ts";

const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const config = JSON.parse(process.env.GB_LOGIN_CONFIG ?? "{}") as { resource: string; clientId: string; stateDir: string };
const login = new Login({ ...config, harness: "pi", loginAction: "run /grayboard login",
  present: url => out({ present: url }), notify: message => out({ notify: message }), diagnostic: record => out({ diagnostic: record }) });
async function outcome(run: () => Promise<unknown>) {
  try { out({ ok: await run() }); }
  catch (error) { out({ error: (error as Error).constructor.name, message: (error as Error).message, reason: (error as { reason?: unknown }).reason }); }
}
const [command, arg] = process.argv.slice(2);
out({ started: process.pid });
if (command === "token") await outcome(() => login.token());
else if (command === "login") await outcome(async () => { await login.login(); return (await login.read())?.epoch; });
else if (command === "token-loop") {
  const until = Date.now() + Number(arg);
  while (Date.now() < until) await outcome(() => login.token());
} else throw new Error(`unknown command ${command}`);
out({ done: true });
