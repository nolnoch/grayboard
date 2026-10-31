import { describe, expect, test } from "bun:test";
import { type ChannelEntry, type ClaudeFiles, claudeChannels, hostFiles } from "./claude_channels.ts";

const HOME = "/home/u";
const MANAGED = "/etc/claude-code";
const PLUGIN: ChannelEntry = "plugin:grayboard@grayboard";
const LOCAL: ChannelEntry = "server:grayboard";
const DEV = "--dangerously-load-development-channels";
const CLI = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" };

type Fixture = { platform?: NodeJS.Platform; files?: Record<string, unknown>; plists?: Record<string, unknown> };

/** A host whose files are `files` (objects become JSON) and nothing else. */
function host({ platform = "linux", files = {}, plists = {} }: Fixture = {}): ClaudeFiles {
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return {
    platform,
    home: HOME,
    user: "u",
    read: (p) => (p in files ? text(files[p]) : null),
    list: (d) => Object.keys(files).filter((p) => p.startsWith(`${d}/`) || p.startsWith(`${d}\\`)).map((p) => p.slice(d.length + 1)),
    plist: (p) => (p in plists ? text(plists[p]) : null),
  };
}

const globalConfig = (v: unknown) => ({ [`${HOME}/.claude.json`]: v });
const team = globalConfig({ oauthAccount: { organizationType: "claude_team" } });
const max = globalConfig({ oauthAccount: { organizationType: "claude_max" } });

function verdict(parentCmd: string | null, opts: { env?: Record<string, string>; entry?: ChannelEntry } & Fixture = {}) {
  return claudeChannels({ env: opts.env ?? CLI, parentCmd, entry: opts.entry ?? PLUGIN, files: host(opts) });
}
const state = (...a: Parameters<typeof verdict>) => verdict(...a).state;
const check = (...a: Parameters<typeof verdict>) => {
  const v = verdict(...a);
  return v.state === "off" ? v.check : v.state;
};

test("hostFiles reads nothing for missing paths", () => {
  const f = hostFiles();
  expect(f.read("/nonexistent/x.json")).toBeNull();
  expect(f.list("/nonexistent")).toEqual([]);
  expect(f.plist("/nonexistent/x.plist")).toBeNull();
});

describe("claudeChannels", () => {
  test("the plugin's launch command, with no account files, is on", () => {
    expect(state(`claude ${DEV} ${PLUGIN}`)).toBe("on");
    expect(state(`/opt/bin/claude --model x ${DEV} ${PLUGIN} --resume abc`)).toBe("on");
  });

  test("a third-party provider is off", () => {
    expect(check(`claude ${DEV} ${PLUGIN}`, { env: { ...CLI, CLAUDE_CODE_USE_BEDROCK: "1" } })).toBe("provider");
    expect(check(`claude ${DEV} ${PLUGIN}`, { env: { ...CLI, CLAUDE_CODE_USE_VERTEX: "true" } })).toBe("provider");
    expect(state(`claude ${DEV} ${PLUGIN}`, { env: { ...CLI, CLAUDE_CODE_USE_BEDROCK: "0" } })).toBe("on");
  });

  test("-p, --print and a non-cli entrypoint are off", () => {
    expect(check(`claude -p ${DEV} ${PLUGIN}`)).toBe("interactive");
    expect(check(`claude --print hi ${DEV} ${PLUGIN}`)).toBe("interactive");
    expect(check(`claude ${DEV} ${PLUGIN}`, { env: { ...CLI, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" } })).toBe("interactive");
    expect(check(`claude ${DEV} ${PLUGIN}`, { env: { CLAUDECODE: "1" } })).toBe("interactive");
    // Decided from the entrypoint even when the command line is unreadable.
    expect(check(null, { env: { ...CLI, CLAUDE_CODE_ENTRYPOINT: "claude-vscode" } })).toBe("interactive");
  });

  test("the session list names the entry exactly", () => {
    expect(check(`claude ${DEV} plugin:other@grayboard`)).toBe("session");
    expect(check(`claude ${DEV} plugin:grayboard@grayboard2`)).toBe("session");
    expect(state(`claude ${DEV} plugin:other@x ${PLUGIN}`)).toBe("on"); // second in the value list
    expect(state(`claude ${DEV}=${PLUGIN}`)).toBe("on");
    expect(check(`claude ${DEV} --resume ${PLUGIN}`)).toBe("session"); // the list ends at the next option
    expect(check("claude --resume web")).toBe("session");
    const v = verdict("claude");
    expect(v.state === "off" && v.reason).toContain(`claude ${DEV} ${PLUGIN}`);
  });

  test("--channels needs the plugin on the org allowlist, else the cached ledger", () => {
    const ledger = globalConfig({ cachedGrowthBookFeatures: { tengu_harbor: true, tengu_harbor_ledger: [{ marketplace: "claude-plugins-official", plugin: "discord" }] } });
    expect(check(`claude --channels ${PLUGIN}`)).toBe("allowlist");
    expect(check(`claude --channels ${PLUGIN}`, { files: ledger })).toBe("allowlist");
    const listed = { ...max, [`${MANAGED}/managed-settings.json`]: { allowedChannelPlugins: [{ marketplace: "grayboard", plugin: "grayboard" }] } };
    expect(state(`claude --channels ${PLUGIN}`, { files: listed })).toBe("on");
    // A ledger entry for grayboard counts when no org list is set.
    const onLedger = globalConfig({ cachedGrowthBookFeatures: { tengu_harbor_ledger: [{ marketplace: "grayboard", plugin: "grayboard" }] } });
    expect(state(`claude --channels ${PLUGIN}`, { files: onLedger })).toBe("on");
    // An org list replaces the ledger, even an empty one.
    const empty = { ...onLedger, [`${MANAGED}/managed-settings.json`]: { channelsEnabled: true, allowedChannelPlugins: [] } };
    expect(check(`claude --channels ${PLUGIN}`, { files: empty })).toBe("allowlist");
    // The dev flag bypasses the allowlist.
    expect(state(`claude --channels plugin:x@y ${DEV} ${PLUGIN}`, { files: empty })).toBe("on");
  });

  test("the feature flag and the org's policy-limits verdict", () => {
    const cmd = `claude ${DEV} ${PLUGIN}`;
    expect(check(cmd, { files: globalConfig({ cachedGrowthBookFeatures: { tengu_harbor: false } }) })).toBe("feature");
    const limits = (v: unknown) => ({ [`${HOME}/.claude/policy-limits.json`]: v });
    expect(check(cmd, { files: limits({ restrictions: { allow_channels: { allowed: false } }, compliance_taints: [] }) })).toBe("org");
    expect(check(cmd, { files: limits({ restrictions: {}, compliance_taints: ["hipaa"] }) })).toBe("org");
    expect(state(cmd, { files: limits({ restrictions: { allow_channels: { allowed: true } } }) })).toBe("on");
    expect(state(cmd, { files: limits("not json") })).toBe("on");
  });

  test("CLAUDE_CONFIG_DIR moves .claude.json and the cached policy files", () => {
    const cmd = `claude ${DEV} ${PLUGIN}`;
    const env = { ...CLI, CLAUDE_CONFIG_DIR: "/cfg" };
    expect(check(cmd, { env, files: { "/cfg/.claude.json": { cachedGrowthBookFeatures: { tengu_harbor: false } } } })).toBe("feature");
    expect(check(cmd, { env, files: { "/cfg/remote-settings.json": { model: "x" } } })).toBe("policy");
    expect(state(cmd, { env, files: { [`${HOME}/.claude/remote-settings.json`]: { model: "x" } } })).toBe("on");
  });

  test("policy: Team and Enterprise need channelsEnabled; Pro and Max never blocked", () => {
    const cmd = `claude ${DEV} ${PLUGIN}`;
    expect(check(cmd, { files: team })).toBe("policy");
    expect(check(cmd, { files: globalConfig({ oauthAccount: { organizationType: "claude_enterprise" } }) })).toBe("policy");
    const enabledRemote = { ...team, [`${HOME}/.claude/remote-settings.json`]: { channelsEnabled: true } };
    expect(state(cmd, { files: enabledRemote })).toBe("on");
    const blockedFile = { ...max, [`${MANAGED}/managed-settings.json`]: { model: "x" } };
    expect(state(cmd, { files: blockedFile })).toBe("on");
  });

  test("policy: an API-key or Console account is off once any managed source lacks channelsEnabled", () => {
    const cmd = `claude ${DEV} ${PLUGIN}`;
    const managed = { [`${MANAGED}/managed-settings.json`]: { model: "x" } };
    expect(state(cmd)).toBe("on");
    expect(check(cmd, { files: managed })).toBe("policy");
    expect(state(cmd, { files: { [`${MANAGED}/managed-settings.json`]: { channelsEnabled: true } } })).toBe("on");
    // A claude.ai account with ANTHROPIC_API_KEY set is an API-key account.
    expect(check(cmd, { env: { ...CLI, ANTHROPIC_API_KEY: "k" }, files: { ...max, ...managed } })).toBe("policy");
    // A source with only control keys delivers no policy.
    expect(state(cmd, { files: { [`${MANAGED}/managed-settings.json`]: { managedSourcesBehavior: "first" } } })).toBe("on");
  });

  test("managed sources: the highest that delivers a policy key wins unless it asks to merge", () => {
    const cmd = `claude ${DEV} ${PLUGIN}`;
    const remote = (v: unknown) => ({ [`${HOME}/.claude/remote-settings.json`]: v });
    const file = (v: unknown) => ({ [`${MANAGED}/managed-settings.json`]: v });
    // First wins: the remote document hides the file's channelsEnabled.
    expect(check(cmd, { files: { ...team, ...remote({ model: "x" }), ...file({ channelsEnabled: true }) } })).toBe("policy");
    // Merge: the file's channelsEnabled applies.
    expect(state(cmd, { files: { ...team, ...remote({ managedSourcesBehavior: "merge", model: "x" }), ...file({ channelsEnabled: true }) } })).toBe("on");
    // A higher source's single value wins under merge.
    expect(check(cmd, { files: { ...team, ...remote({ managedSourcesBehavior: "merge", channelsEnabled: false }), ...file({ channelsEnabled: true }) } })).toBe("policy");
  });

  test("managed settings drop-ins merge after the file, alphabetically", () => {
    const cmd = `claude ${DEV} ${PLUGIN}`;
    const files = {
      ...team,
      [`${MANAGED}/managed-settings.json`]: { channelsEnabled: false },
      [`${MANAGED}/managed-settings.d/20-b.json`]: { channelsEnabled: true },
      [`${MANAGED}/managed-settings.d/10-a.json`]: { channelsEnabled: false },
    };
    expect(state(cmd, { files })).toBe("on");
    expect(check(cmd, { files: { ...files, [`${MANAGED}/managed-settings.d/30-c.json`]: { channelsEnabled: false } } })).toBe("policy");
    expect(state(cmd, { files: { ...files, [`${MANAGED}/managed-settings.d/30-c.txt`]: { channelsEnabled: false } } })).toBe("on");
    // Lists union across drop-ins.
    const lists = {
      ...max,
      [`${MANAGED}/managed-settings.json`]: { allowedChannelPlugins: [{ marketplace: "m", plugin: "p" }] },
      [`${MANAGED}/managed-settings.d/10-a.json`]: { allowedChannelPlugins: [{ marketplace: "grayboard", plugin: "grayboard" }] },
    };
    expect(state(`claude --channels ${PLUGIN}`, { files: lists })).toBe("on");
  });

  test("macOS: the MDM plist outranks the managed settings file", () => {
    const cmd = `claude ${DEV} ${PLUGIN}`;
    const dir = "/Library/Application Support/ClaudeCode";
    const plists = { "/Library/Managed Preferences/com.anthropic.claudecode.plist": { model: "x" } };
    expect(check(cmd, { platform: "darwin", plists, files: { ...team, [`${dir}/managed-settings.json`]: { channelsEnabled: true } } })).toBe("policy");
    expect(state(cmd, { platform: "darwin", files: { ...team, [`${dir}/managed-settings.json`]: { channelsEnabled: true } } })).toBe("on");
    const user = { "/Library/Managed Preferences/u/com.anthropic.claudecode.plist": { channelsEnabled: true }, ...plists };
    expect(state(cmd, { platform: "darwin", plists: user, files: team })).toBe("on");
  });

  test("Windows: an unreadable registry policy makes a policy-dependent answer unknown", () => {
    const cmd = `claude ${DEV} ${PLUGIN}`;
    expect(state(cmd, { platform: "win32", files: team })).toBe("unknown");
    expect(state(cmd, { platform: "win32", files: { ...team, "C:\\Program Files\\ClaudeCode\\managed-settings.json": { channelsEnabled: true } } })).toBe("unknown");
    expect(state(cmd, { platform: "win32" })).toBe("unknown"); // API key / Console: HKLM or HKCU may deploy one
    expect(state(cmd, { platform: "win32", files: max })).toBe("on"); // Pro/Max: policy never applies
    expect(state(cmd, { platform: "win32", files: { ...team, [`${HOME}/.claude/remote-settings.json`]: { channelsEnabled: true } } })).toBe("on");
    // An off check that doesn't depend on policy still says off.
    expect(check("claude", { platform: "win32", files: team })).toBe("session");
  });

  test("an unreadable command line is unknown", () => {
    expect(state(null)).toBe("unknown");
    expect(check(null, { files: team })).toBe("policy");
  });

  test("local server:grayboard: the dev flag only, and -p is off", () => {
    expect(state(`claude ${DEV} ${LOCAL}`, { entry: LOCAL })).toBe("on");
    expect(state(`claude ${DEV} ${LOCAL} --resume x`, { entry: LOCAL })).toBe("on");
    expect(check(`claude --channels ${LOCAL}`, { entry: LOCAL })).toBe("session");
    expect(check(`claude ${DEV} ${PLUGIN}`, { entry: LOCAL })).toBe("session");
    expect(check(`claude -p ${DEV} ${LOCAL}`, { entry: LOCAL })).toBe("interactive");
  });
});
