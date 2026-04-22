import { test } from "bun:test";

// Integration tests require a running server with GRAYBOARD_DEV_AUTH=1.
// Run: GRAYBOARD_DEV_AUTH=1 GRAYBOARD_DB_PATH=:memory: GRAYBOARD_PUBLIC_URL=http://localhost bun src/server/main.ts
// Then: bun test tests/integration

test.todo("WS flow: hello -> drain -> send -> ack -> cursor advances");
test.todo("team fan-out: send to team, three connected member identities all receive");
test.todo("offline member receives on reconnect drain");
test.todo("superseded connection: second hello with same identity closes the first");
test.todo("reconnect after server restart drains messages that arrived during gap");
test.todo("admin revoke-session causes next MCP reconnect to fail auth");
