import { Plugin } from "@opencode/plugin/effect";
import type { Context } from "@opencode/plugin/effect/plugin";
import { Effect, type Scope } from "effect";

export type NativeInput = Parameters<Context["session"]["synthetic"]>[0];
export type NativeAdmission = Effect.Success<ReturnType<Context["session"]["synthetic"]>>;
export type Forward = (input: NativeInput) => Promise<NativeAdmission>;
export function instrument(plugin: Plugin.Plugin<Scope.Scope>, intercept: (input: NativeInput, forward: Forward) => Promise<NativeAdmission>) {
  return Plugin.define({ id: plugin.id, effect: host => Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    yield* plugin.effect({ ...host, session: new Proxy(host.session, { get(session, key) {
      if (key === "synthetic") return (input: NativeInput) => Effect.promise(() => intercept(input, value => run(session.synthetic(value))));
      return Reflect.get(session, key);
    } }) });
  }) });
}
