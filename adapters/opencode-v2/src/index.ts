import { Plugin } from "@opencode/plugin/effect";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { Effect } from "effect";
import { captureLogger } from "./logger.js";
import { setup } from "./lifecycle.js";
export { Grayboard } from "./rpc.js";

export default Plugin.define({ id: "grayboard", effect: host => Effect.gen(function* () {
  const logger = yield* captureLogger;
  yield* Effect.addFinalizer(() => Effect.sync(() => logger.close()));
  yield* fromPromise({ id: "grayboard", setup: ctx => setup(ctx, record => logger.emit(record)) }).effect(host);
}) });
