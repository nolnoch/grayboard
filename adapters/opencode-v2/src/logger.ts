import { Effect } from "effect";
import { logFields, type RecordStatus } from "./core/diagnostics.js";

export const captureLogger = Effect.gen(function* () {
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  let closed = false;
  return {
    close() { closed = true; },
    async emit(record: Readonly<RecordStatus>) {
      if (closed) return;
      const fields = logFields(record);
      if (!fields) return;
      const entry = fields.code || ["paused", "degraded", "retrying"].includes(fields.state)
        ? Effect.logWarning("Grayboard subscriber state", fields)
        : Effect.logInfo("Grayboard subscriber state", fields);
      await run(entry);
    },
  };
});
