// piAgentDir follows pi's own rule for PI_CODING_AGENT_DIR (#279 audit 14):
// empty is unset, `~` expands, a file:// URL converts, anything else is as is.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { ompAgentDir, ompSetupRefusal, piAgentDir, piSetupAgentDir } from "./pi.ts";

const HOME = "/home/you";

test("unset or empty is ~/.pi/agent, never the current directory", () => {
  expect(piAgentDir({}, HOME)).toBe("/home/you/.pi/agent");
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "" }, HOME)).toBe("/home/you/.pi/agent");
});

test("a leading ~ expands to the home directory; a file:// URL converts; other paths are kept", () => {
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "~" }, HOME)).toBe(HOME);
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/agents/pi" }, HOME)).toBe("/home/you/agents/pi");
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "file:///srv/pi%20agent" }, HOME)).toBe("/srv/pi agent");
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "/srv/pi" }, HOME)).toBe("/srv/pi");
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "~other/pi" }, HOME)).toBe("~other/pi");
});

// The local pi adapter installs as one raw file, so it carries its own copy of
// the rule; with an empty variable it read ./mcp.json and ran a repo's command
// (#437). Imported with the variable aimed at an empty scratch dir, so loading
// it reads no real mcp.json.
test("the local pi adapter's copy resolves every case as piAgentDir does (#437)", async () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/nonexistent/grayboard-437";
  try {
    const { agentDir } = await import("../../adapters/pi/grayboard.ts");
    for (const value of [undefined, "", "~", "~/agents/pi", "file:///srv/pi%20agent", "/srv/pi", "~other/pi", "relative/pi"]) {
      const env = value === undefined ? {} : { PI_CODING_AGENT_DIR: value };
      expect(agentDir(env, HOME)).toBe(piAgentDir(env, HOME));
    }
    expect(agentDir({ PI_CODING_AGENT_DIR: "" }, HOME)).toBe("/home/you/.pi/agent");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

// ompAgentDir follows omp's getAgentDir() (#439): the omp adapters read it,
// so setup must install there.
test("ompAgentDir: the default is ~/.omp/agent; PI_CONFIG_DIR moves the root", () => {
  expect(ompAgentDir({}, HOME)).toBe("/home/you/.omp/agent");
  expect(ompAgentDir({ PI_CODING_AGENT_DIR: "" }, HOME)).toBe("/home/you/.omp/agent");
  expect(ompAgentDir({ PI_CONFIG_DIR: ".omp-work" }, HOME)).toBe("/home/you/.omp-work/agent");
});

test("ompAgentDir: a named profile has its own agent dir and ignores PI_CODING_AGENT_DIR", () => {
  expect(ompAgentDir({ OMP_PROFILE: "work" }, HOME)).toBe("/home/you/.omp/profiles/work/agent");
  expect(ompAgentDir({ PI_PROFILE: "work" }, HOME)).toBe("/home/you/.omp/profiles/work/agent");
  expect(ompAgentDir({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/srv/omp" }, HOME)).toBe("/home/you/.omp/profiles/work/agent");
  // OMP_PROFILE wins over PI_PROFILE, and an empty or "default" one selects the default profile.
  expect(ompAgentDir({ OMP_PROFILE: "a", PI_PROFILE: "b" }, HOME)).toBe("/home/you/.omp/profiles/a/agent");
  expect(ompAgentDir({ OMP_PROFILE: "", PI_PROFILE: "b" }, HOME)).toBe("/home/you/.omp/agent");
  expect(ompAgentDir({ OMP_PROFILE: "default" }, HOME)).toBe("/home/you/.omp/agent");
  // An invalid name resolves as the default profile, as omp's module load does.
  expect(ompAgentDir({ OMP_PROFILE: "Bad/Name" }, HOME)).toBe("/home/you/.omp/agent");
  expect(ompAgentDir({ OMP_PROFILE: "con" }, HOME)).toBe("/home/you/.omp/agent");
});

test("ompAgentDir: the default profile honors PI_CODING_AGENT_DIR, path-resolved, unless it is PI_PROFILE's own dir", () => {
  expect(ompAgentDir({ PI_CODING_AGENT_DIR: "/srv/omp" }, HOME)).toBe("/srv/omp");
  // No `~` expansion: omp path.resolve()s it against the current directory.
  expect(ompAgentDir({ PI_CODING_AGENT_DIR: "~/omp" }, HOME)).toBe(join(process.cwd(), "~/omp"));
  // A parent omp's profile switch propagated PI_CODING_AGENT_DIR; OMP_PROFILE="" chose the default profile.
  expect(ompAgentDir({ OMP_PROFILE: "", PI_PROFILE: "w", PI_CODING_AGENT_DIR: "/home/you/.omp/profiles/w/agent" }, HOME)).toBe("/home/you/.omp/agent");
});

// The rule above is a copy of omp's; this runs omp's own getAgentDir() (the
// pinned @oh-my-pi/pi-utils) per case, so an omp upgrade that changes it fails here.
test("ompAgentDir matches omp's getAgentDir() in every case", () => {
  const cases: Record<string, string>[] = [
    {}, { PI_CONFIG_DIR: ".omp-work" }, { OMP_PROFILE: "work" }, { PI_PROFILE: "work" },
    { OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/srv/omp" }, { OMP_PROFILE: "a", PI_PROFILE: "b" }, { OMP_PROFILE: "", PI_PROFILE: "b" },
    { OMP_PROFILE: "default" }, { OMP_PROFILE: "Bad/Name" }, { OMP_PROFILE: "con" }, { PI_CODING_AGENT_DIR: "/srv/omp" }, { PI_CODING_AGENT_DIR: "~/omp" },
    { PI_CODING_AGENT_DIR: "rel/omp" }, { OMP_PROFILE: "", PI_PROFILE: "w", PI_CODING_AGENT_DIR: "/home/you/.omp/profiles/w/agent" },
  ];
  const keys = ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];
  for (const c of cases) {
    const env: Record<string, string | undefined> = { ...process.env, HOME };
    for (const k of keys) delete env[k];
    Object.assign(env, c);
    const r = Bun.spawnSync([process.execPath, "--no-env-file", "-e", `import { getAgentDir } from "@oh-my-pi/pi-utils/dirs"; console.log(getAgentDir())`], { env, cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect([c, ompAgentDir(c, HOME)]).toEqual([c, r.stdout.toString().trim()]);
  }
}, 60_000);

test("piSetupAgentDir: an omp profile's own exported PI_CODING_AGENT_DIR is omp's, so pi's is its default", () => {
  expect(piSetupAgentDir({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/home/you/.omp/profiles/work/agent" }, HOME)).toBe("/home/you/.pi/agent");
  expect(piSetupAgentDir({ PI_PROFILE: "work", PI_CODING_AGENT_DIR: "/home/you/.omp/profiles/work/agent" }, HOME)).toBe("/home/you/.pi/agent");
  // Any other value is the user's pi setting.
  expect(piSetupAgentDir({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/srv/pi" }, HOME)).toBe("/srv/pi");
  expect(piSetupAgentDir({ PI_CODING_AGENT_DIR: "/home/you/.omp/profiles/work/agent" }, HOME)).toBe("/home/you/.omp/profiles/work/agent");
});

test("ompSetupRefusal names the cause: a relative default-profile override, a shared PI_CODING_AGENT_DIR, or PI_CONFIG_DIR", () => {
  expect(ompSetupRefusal({}, HOME)).toBeUndefined();
  expect(ompSetupRefusal({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/home/you/.omp/profiles/work/agent" }, HOME)).toBeUndefined();
  expect(ompSetupRefusal({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "rel" }, HOME)).toBeUndefined();
  expect(ompSetupRefusal({ PI_CODING_AGENT_DIR: "~/x" }, HOME)).toStartWith("omp resolves PI_CODING_AGENT_DIR (~/x) against the directory omp starts in");
  expect(ompSetupRefusal({ PI_CODING_AGENT_DIR: "file:///x" }, HOME)).toStartWith("omp resolves PI_CODING_AGENT_DIR (file:///x)");
  expect(ompSetupRefusal({ PI_CODING_AGENT_DIR: "/srv/a" }, HOME)).toStartWith("omp's agent directory is pi's (/srv/a: omp reads PI_CODING_AGENT_DIR too)");
  expect(ompSetupRefusal({ PI_CONFIG_DIR: ".pi" }, HOME)).toStartWith("omp's agent directory is pi's (/home/you/.pi/agent: PI_CONFIG_DIR=.pi puts omp's root where pi's is)");
});
