// OpenCode V2's static mode (src/lifecycle.ts `staticMode`) and hosted core's (adapters/hosted-core/src/static.ts) read
// the same launcher environment and must give one launcher mistake the same answer in every harness (#1313, #1318).
// One table runs through both; a change to either side's rule or refusal text fails here.
//
// It lives in OpenCode V2's tests, not the root suite: lifecycle.ts imports OpenCode's plugin types, which only this
// package's own install has (the root typecheck excludes tests/e2e/opencode-config.ts for the same reason). Hosted
// core's static.ts is imported by relative path: scripts/sync_hosted_core.ts doesn't vendor it.
//
// The table holds only the common contract. Documented differences are kept out of it:
// - hosted core compares the exec-time environment (`launch`) and the Claude Code project settings files; V2 reads
//   neither, so hosted core runs with `launch` undefined and no settings dirs;
// - hosted core reads the run token from the environment, requires it in static mode and checks its shape; V2 gets it
//   through the launcher's entry (`Bearer {env:GRAYBOARD_RUN_TOKEN}`), whose shape its Binding checks. Every static row
//   carries a well-formed token, and hosted core's `token` field is dropped before comparing;
// - V2 accepts only an HTTPS issuer, hosted core also HTTP loopback, and their issuer-shape texts differ: those rows
//   are checked below for a refusal on both sides, not for the same text.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticMode as v2 } from "../src/lifecycle.js";
import { staticMode as core } from "../../hosted-core/src/static.js";

type Env = Record<string, string | undefined>;
const ISSUER = "https://grayboard.example.com", TOKEN = "run-token-CANARY-0123456789abcdef";
const ON = { GRAYBOARD_AUTH: "static", GRAYBOARD_ISSUER: ISSUER, GRAYBOARD_RUN_TOKEN: TOKEN };
const NO_MODE = { refused: "GRAYBOARD_RUN_TOKEN is set without GRAYBOARD_AUTH=static" };
const dotenvRefusal = (file: string) => ({ refused: `Static mode refused: ${file} in the working directory sets its variables; the launcher sets them` });

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
// A working directory holding `files` (a name mapped to null is a directory, which reads as unreadable).
function cwd(files: Record<string, string | null> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "gb-static-pin-")); dirs.push(d);
  for (const [name, text] of Object.entries(files)) text === null ? mkdirSync(join(d, name)) : writeFileSync(join(d, name), text);
  return d;
}

// Thin adapters: both are synchronous over an env object and a cwd. Hosted core gets no exec-time environment and no
// Claude Code settings dirs; its token field, which V2's mode doesn't carry, is dropped.
function hosted(env: Env, dir: string): unknown {
  const mode = core(env, dir, [], undefined);
  if (mode === undefined || "refused" in mode) return mode;
  const { token, ...rest } = mode;
  expect(token).toBe(TOKEN);
  return rest;
}

type Row = { name: string; env: Env; files?: Record<string, string | null>; mode: unknown };
const rows: Row[] = [
  // No mode: OAuth.
  { name: "nothing set", env: {}, mode: undefined },
  { name: "empty GRAYBOARD_AUTH", env: { GRAYBOARD_AUTH: "" }, mode: undefined },
  { name: "empty run token", env: { GRAYBOARD_RUN_TOKEN: "" }, mode: undefined },
  { name: "issuer and principal without the mode are ignored", env: { GRAYBOARD_ISSUER: ISSUER, GRAYBOARD_PRINCIPAL: "ingest" }, mode: undefined },
  { name: "a dotenv file is read only once the environment asks for the mode", env: {}, files: { ".env": "GRAYBOARD_AUTH=static\n" }, mode: undefined },
  // Static mode.
  { name: "run token with GRAYBOARD_AUTH=static", env: ON, mode: { issuer: ISSUER } },
  { name: "with a principal", env: { ...ON, GRAYBOARD_PRINCIPAL: "ingest" }, mode: { issuer: ISSUER, principal: "ingest" } },
  { name: "with an empty principal", env: { ...ON, GRAYBOARD_PRINCIPAL: "" }, mode: { issuer: ISSUER } },
  { name: "a 128-character principal", env: { ...ON, GRAYBOARD_PRINCIPAL: "p".repeat(128) }, mode: { issuer: ISSUER, principal: "p".repeat(128) } },
  { name: "an unrelated dotenv file", env: ON, files: { ".env": "UNRELATED=1\nGRAYBOARD_AUTHX=1\n" }, mode: { issuer: ISSUER } },
  { name: "the pre-#1300 names beside the new ones", env: { ...ON, GRAYBOARD_OPENCODE_AUTH: "oauth", GRAYBOARD_OPENCODE_ISSUER: "https://elsewhere.example.com" }, mode: { issuer: ISSUER } },
  // A run token without the mode (#1313).
  { name: "run token alone", env: { GRAYBOARD_RUN_TOKEN: TOKEN }, mode: NO_MODE },
  { name: "run token with an empty GRAYBOARD_AUTH", env: { GRAYBOARD_RUN_TOKEN: TOKEN, GRAYBOARD_AUTH: "" }, mode: NO_MODE },
  { name: "run token with issuer and principal but no mode", env: { GRAYBOARD_RUN_TOKEN: TOKEN, GRAYBOARD_ISSUER: ISSUER, GRAYBOARD_PRINCIPAL: "ingest" }, mode: NO_MODE },
  // The mode's value.
  { name: "GRAYBOARD_AUTH=oauth", env: { ...ON, GRAYBOARD_AUTH: "oauth" }, mode: { refused: 'GRAYBOARD_AUTH must be "static" or unset' } },
  { name: "GRAYBOARD_AUTH=STATIC", env: { ...ON, GRAYBOARD_AUTH: "STATIC" }, mode: { refused: 'GRAYBOARD_AUTH must be "static" or unset' } },
  { name: "a bad mode is named before a missing issuer", env: { GRAYBOARD_AUTH: "oauth", GRAYBOARD_RUN_TOKEN: TOKEN }, mode: { refused: 'GRAYBOARD_AUTH must be "static" or unset' } },
  { name: "a bad mode without a run token", env: { GRAYBOARD_AUTH: "oauth" }, mode: { refused: 'GRAYBOARD_AUTH must be "static" or unset' } },
  // The pin.
  { name: "no issuer", env: { ...ON, GRAYBOARD_ISSUER: undefined }, mode: { refused: "Static mode needs a pinned issuer (GRAYBOARD_ISSUER)" } },
  { name: "empty issuer", env: { ...ON, GRAYBOARD_ISSUER: "" }, mode: { refused: "Static mode needs a pinned issuer (GRAYBOARD_ISSUER)" } },
  { name: "a missing issuer is named before a bad principal", env: { ...ON, GRAYBOARD_ISSUER: undefined, GRAYBOARD_PRINCIPAL: "in gest" }, mode: { refused: "Static mode needs a pinned issuer (GRAYBOARD_ISSUER)" } },
  // The principal.
  ...["in gest", "ingest/w-1", "p".repeat(129)].map(principal => ({ name: `principal ${JSON.stringify(principal.slice(0, 16))}`, env: { ...ON, GRAYBOARD_PRINCIPAL: principal }, mode: { refused: "GRAYBOARD_PRINCIPAL must be a service name" } })),
  // A repository's dotenv file: every grammar Bun's parser takes, every variable, every .env* name.
  ...([
    [".env", "GRAYBOARD_AUTH=static\n"],
    [".env.local", `export GRAYBOARD_ISSUER=${ISSUER}\n`],
    [".env.production", "  GRAYBOARD_AUTH = static"],
    [".env", "GRAYBOARD_PRINCIPAL=other\n"],
    [".env", `GRAYBOARD_RUN_TOKEN=${TOKEN}\n`],
    [".env", "GRAYBOARD_AUTH: static\n"],
    [".env.local", `export GRAYBOARD_ISSUER: ${ISSUER}\n`],
    [".env.development", `UNRELATED=1\n\tGRAYBOARD_RUN_TOKEN=${TOKEN}\n`],
  ] as const).map(([file, text]) => ({ name: `${file} ${JSON.stringify(text.trim())}`, env: ON, files: { [file]: text }, mode: dotenvRefusal(file) })),
  { name: "a dotenv file is named before a run token without the mode", env: { GRAYBOARD_RUN_TOKEN: TOKEN }, files: { ".env": `GRAYBOARD_RUN_TOKEN=${TOKEN}\n` }, mode: dotenvRefusal(".env") },
  { name: "a dotenv file is named before a bad mode", env: { GRAYBOARD_AUTH: "oauth" }, files: { ".env": "GRAYBOARD_AUTH=oauth\n" }, mode: dotenvRefusal(".env") },
  { name: "a dotenv file is named before a missing issuer", env: { GRAYBOARD_AUTH: "static", GRAYBOARD_RUN_TOKEN: TOKEN }, files: { ".env.local": "GRAYBOARD_AUTH=static\n" }, mode: dotenvRefusal(".env.local") },
  { name: "an unreadable dotenv file", env: ON, files: { ".env": null }, mode: { refused: "Static mode refused: .env in the working directory is unreadable" } },
];

test.each(rows.map(row => [row.name, row] as const))("V2 and hosted core agree: %s", (_name, row) => {
  const dir = cwd(row.files);
  const env = Object.fromEntries(Object.entries(row.env).filter(([, v]) => v !== undefined));
  expect(hosted(env, dir)).toEqual(row.mode);
  expect(v2(env, dir)).toEqual(row.mode as never);
});

// The issuer's shape: both refuse, in their own words (V2 is HTTPS-only; hosted core also takes HTTP loopback).
test.each(["http://grayboard.example.com", "https://u:p@grayboard.example.com", "https://grayboard.example.com/?q=1", "https://grayboard.example.com/#f", "not a url"])("both refuse the issuer %s", issuer => {
  const env = { ...ON, GRAYBOARD_ISSUER: issuer }, dir = cwd();
  expect(hosted(env, dir)).toEqual({ refused: expect.stringMatching(/^GRAYBOARD_ISSUER must be an HTTPS URL/) });
  expect(v2(env, dir)).toEqual({ refused: expect.stringMatching(/^GRAYBOARD_ISSUER must be an HTTPS URL/) });
});
