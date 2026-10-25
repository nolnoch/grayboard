import * as Plugin from "@opencode/plugin/tui/plugin";
import { Grayboard } from "./rpc.js";
export default Plugin.define({ id: "grayboard.tui", setup(context) {
  const rpc = context.client.rpc(Grayboard);
  context.keymap.layer(() => ({ mode: "global", commands: [
    { id: "grayboard.enroll", title: "Grayboard: enroll current root", palette: true, slash: { name: "grayboard-enroll" }, run: async () => {
      const route = context.ui.router.current();
      if (route.type !== "session") return context.ui.toast.show({ message: "Open an active root session first", variant: "error" });
      const session = context.data.session.get(route.sessionID);
      if (!session || session.parentID || session.time.archived) return context.ui.toast.show({ message: "An active root session is required", variant: "error" });
      if (!await context.ui.dialog.confirm({ title: "Enroll Grayboard", message: "Deliver the configured Grayboard identity to this root session? Actionable messages can wake the agent. This replaces the current delivery target." })) return;
      const result = await rpc.enroll({ sessionID: route.sessionID }, { location: context.location ?? context.data.location.default() });
      context.ui.toast.show({ message: result.message, variant: result.state === "paused" ? "error" : "success" });
    } },
    { id: "grayboard.pause", title: "Grayboard: pause delivery", palette: true, slash: { name: "grayboard-pause" }, run: async () => {
      const result = await rpc.pause({}, { location: context.location ?? context.data.location.default() });
      context.ui.toast.show({ message: result.message, variant: "info" });
    } },
    { id: "grayboard.status", title: "Grayboard: delivery status", palette: true, slash: { name: "grayboard-status" }, run: async () => {
      const result = await rpc.status({}, { location: context.location ?? context.data.location.default() });
      await context.ui.dialog.alert({ title: `Grayboard: ${result.state}`, message: result.message });
    } },
  ] }));
} });
