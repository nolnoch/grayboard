// Runs before any test file (bunfig.toml). A test run must never open the
// developer's live bus: opening one upgrades its schema under the sessions it
// serves, and a `grayboard mcp` on it would run retention. So this process and
// every child that inherits its env default to a throwaway bus, and the live
// paths are named to openLocalDb, which refuses them (src/local/open.ts).
// Compiled releases predate the refusal; only the redirect covers them, and
// the helpers in env.ts give them their own bus and HOME.
import { afterAll, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const live = [join(homedir(), ".claude-bus", "bus.db"), ...(process.env.BUS_DB_PATH ? [process.env.BUS_DB_PATH] : [])];
const dir = mkdtempSync(join(tmpdir(), "gbt-"));
process.env.GRAYBOARD_TEST_FORBID_BUS = live.join(delimiter);
process.env.BUS_DB_PATH = join(dir, "bus.db");
process.env.BUS_SOCK_DIR = dir;
// Tests' own mkdtemp dirs land here too, and go with the run; a killed run leaves this one.
process.env.TMPDIR = dir;
// A preload's hooks run once per pass: once in a plain run, and once per
// --rerun-each pass, so the next pass needs the dir back. Process "exit" doesn't fire here.
beforeAll(() => mkdirSync(dir, { recursive: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
