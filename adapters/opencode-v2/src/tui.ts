import * as Plugin from "@opencode/plugin/tui/plugin";
import { Grayboard } from "./rpc.js";
export default Plugin.define({ id: "grayboard.tui", setup(context) {
  const rpc = context.client.rpc(Grayboard);
  context.keymap.layer(() => ({ mode: "global", commands: [
    { id: "grayboard.enroll", title: "Grayboard: enroll current root", palette: true, slash: { name: "grayboard-enroll" }, run: async input => {
      const route = context.ui.router.current();
      if (route.type !== "session") return context.ui.toast.show({ message: "Open an active root session first", variant: "error" });
      const session = context.data.session.get(route.sessionID);
      if (!session || session.parentID || session.time.archived) return context.ui.toast.show({ message: "An active root session is required", variant: "error" });
      const args = (input ?? "").trim().split(/\s+/).filter(Boolean);
      const create = args.includes("--create"), names = args.filter(arg => arg !== "--create");
      if (names.length > 1 || names.some(arg => arg.startsWith("--")) || create && !names.length) return context.ui.toast.show({ message: "Usage: /grayboard-enroll [name] [--create]", variant: "error" });
      if (!await context.ui.dialog.confirm({ title: "Enroll Grayboard", message: `Approve this root for Grayboard delivery? Actionable messages can wake the agent.${names[0] ? ` Then bind ${names[0]}${create ? " (creating it if absent)" : " without creating it"}.` : " Approval alone does not bind a name."}` })) return;
      const result = await rpc.enroll({ sessionID: route.sessionID, name: names[0], create }, { location: context.location ?? context.data.location.default() });
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
