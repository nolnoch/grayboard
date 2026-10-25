import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
const status = z.strictObject({ state: z.string(), message: z.string(), sessionID: z.string().optional() });
export const Grayboard = Rpc.define({ id: "grayboard", events: {}, methods: {
  status: { input: z.strictObject({}), output: status },
  enroll: { input: z.strictObject({ sessionID: z.string(), name: z.string().optional(), create: z.boolean().optional() }), output: status },
  pause: { input: z.strictObject({}), output: status },
} });
