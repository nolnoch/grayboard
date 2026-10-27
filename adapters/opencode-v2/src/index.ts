import { Plugin } from "@opencode/plugin";
import { Controller, type Options } from "./controller.js";
import { Grayboard } from "./rpc.js";
import { Refusal } from "./model.js";
import { observeEvents } from "./events.js";
export { Grayboard } from "./rpc.js";
export default Plugin.define({ id: "grayboard", async setup(ctx) {
  const options: Options = {
    mcpName: typeof ctx.options.mcpName === "string" ? ctx.options.mcpName : "grayboard",
    issuer: typeof ctx.options.issuer === "string" ? ctx.options.issuer : "",
    name: typeof ctx.options.name === "string" ? ctx.options.name : undefined,
    create: ctx.options.create === true,
  };
  const controller = new Controller(ctx, options);
  let restoring: Promise<unknown> = Promise.resolve();
  const rpc = await ctx.rpc.register(Grayboard, {
    status: async () => controller.status(),
    enroll: async input => {
      try { await restoring; return await controller.enroll(input.sessionID, input.name, input.create); }
      catch (error) { return { state: "paused", message: error instanceof Refusal ? error.message : "Enrollment refused; check the active root, trusted issuer and native MCP configuration/sign-in" }; }
    },
    pause: async () => { await restoring; return controller.pause(); },
  });
  const before = await ctx.tool.hook("execute.before", event => controller.before(event));
  const after = await ctx.tool.hook("execute.after", event => controller.after(event).catch(() => {}));
  const events = new AbortController();
  const listening = observeEvents(
    () => ctx.event.subscribe({ signal: events.signal }),
    event => controller.observe(event.type, event.data),
    operation => controller.backgroundFailure(operation),
    events.signal,
  );
  restoring = (async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let attempt = 0; attempt < 50 && !events.signal.aborted; attempt++) {
      try { await controller.binding.configuration(); break; }
      catch (error) {
        if (!(error instanceof Refusal) || error.code !== "binding" || attempt === 49) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await controller.restore().catch(() => { if (!events.signal.aborted) controller.backgroundFailure("restore"); });
  })();
  return async () => {
    events.abort();
    await controller.close();
    await restoring;
    await listening;
    await before.dispose().catch(() => {});
    await after.dispose().catch(() => {});
    await rpc.dispose().catch(() => {});
  };
} });
