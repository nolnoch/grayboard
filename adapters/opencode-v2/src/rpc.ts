import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
const root = z.strictObject({ state: z.string(), message: z.string(), sessionID: z.string().optional(), time: z.number(), name: z.string().optional(), ownership: z.number().optional(), operation: z.string(), code: z.string().optional(), failure: z.strictObject({ operation: z.string(), code: z.string(), time: z.number() }).optional() });
const status = z.strictObject({ state: z.string(), message: z.string(), sessionID: z.string().optional(), roots: z.array(root) });
export const Grayboard = Rpc.define({ id: "grayboard", events: {}, methods: {
  status: { input: z.strictObject({}), output: status },
  enroll: { input: z.strictObject({ sessionID: z.string(), name: z.string().optional(), create: z.boolean().optional() }), output: status },
  pause: { input: z.strictObject({}), output: status },
} });
