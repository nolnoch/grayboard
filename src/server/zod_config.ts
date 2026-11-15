// Turns off zod's cycle-support memoizer for the server process (#940). zod 4.6 installs it by default and it wraps
// every container whose schema is recursive (the MCP SDK's JSON value and result-meta schemas among them) with a
// per-parse WeakMap lookup, and clones issues on every miss: about 1% of server CPU at 1000 sessions, and about a third
// of the SDK's message-parse time in a microbenchmark. It buys only parsing of cyclic object graphs, which JSON.parse
// can't produce and JSON.stringify can't send. With it off, zod behaves as zod/mini does by default.
//
// zod reads the memoizer when a schema is constructed, so this must run before any module that builds a schema:
// src/server/main.ts imports it first (zod_config.test.ts pins that). Code that builds the server some other way
// (tests through TestServer) keeps the default memoizer, which is slower and otherwise identical for JSON input.
import { config, type $ZodMemoizer } from "zod/v4/core";

const noMemoizer: $ZodMemoizer = {
  attach() {},
  guard() {},
  alloc(_inst, _payload, empty) { return empty; },
};

config({ memoizer: noMemoizer });
