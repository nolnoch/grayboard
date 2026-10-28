import { AbsolutePath, Credential, Location, Model, OpenCode, Provider, Session } from "@opencode/sdk/effect";
import { Context, Effect, Exit, Scope } from "effect";
import type { Grayboard } from "../src/rpc.js";

type Native = Effect.Success<ReturnType<typeof OpenCode.create>>;
type Arg<F extends (...args: never[]) => unknown> = Parameters<F>[0];
type Located = { location?: { directory: string } };
type SessionArg<T> = Omit<T, "sessionID"> & { sessionID: string };
const location = (value: { directory: string }) => Location.Ref.make({ directory: AbsolutePath.make(value.directory) });
const session = <T extends { sessionID: string }>(value: T) => ({ ...value, sessionID: Session.ID.make(value.sessionID) });

export async function ownedScope() {
  const scope = await Effect.runPromise(Scope.make());
  const run = Effect.runPromiseWith(Context.make(Scope.Scope, scope));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= run(Scope.close(scope, Exit.succeed(undefined)));
  return { run, close };
}

// Only the methods used by these fixtures; native results stay native, including DateTime timestamps.
export async function createFixtureHost(options: OpenCode.CreateOptions) {
  const { run, close } = await ownedScope();
  let host: Native;
  try { host = await run(OpenCode.create(options)); } catch (error) { await close(); throw error; }
  return {
    close,
    agent: { list: (input: Located) => run(host.agent.list({ ...input, ...(input.location ? { location: location(input.location) } : {}) })) },
    mcp: { connect: (input: { server: string; location: { directory: string } }) => run(host.mcp.connect({ ...input, location: location(input.location) })) },
    session: {
      create: (input: Omit<NonNullable<Arg<Native["session"]["create"]>>, "location" | "parentID"> & Located & { parentID?: string }) => {
        const { location: loc, parentID, ...rest } = input;
        return run(host.session.create({ ...rest, ...(loc ? { location: location(loc) } : {}), ...(parentID ? { parentID: Session.ID.make(parentID) } : {}) }));
      },
      get: (input: SessionArg<Arg<Native["session"]["get"]>>) => run(host.session.get(session(input))),
      remove: (input: SessionArg<Arg<Native["session"]["remove"]>>) => run(host.session.remove(session(input))),
      update: (input: SessionArg<Arg<Native["session"]["update"]>>) => run(host.session.update(session(input))),
      wait: (input: SessionArg<Arg<Native["session"]["wait"]>>) => run(host.session.wait(session(input))),
      context: (input: SessionArg<Arg<Native["session"]["context"]>>) => run(host.session.context(session(input))),
      prompt: (input: SessionArg<Arg<Native["session"]["prompt"]>>) => run(host.session.prompt(session(input))),
      switchModel: (input: { sessionID: string; model: { providerID: string; id: string } }) => run(host.session.switchModel({ ...session(input), model: { providerID: Provider.ID.make(input.model.providerID), id: Model.ID.make(input.model.id) } })),
      inbox: { list: (input: SessionArg<Arg<Native["session"]["inbox"]["list"]>>) => run(host.session.inbox.list(session(input))) },
    },
    credential: {
      list: () => run(host.credential.list()),
      activate: (input: { credentialID: string }) => run(host.credential.activate({ credentialID: Credential.ID.make(input.credentialID) })),
      create: (input: Arg<Native["credential"]["create"]>) => run(host.credential.create(input)),
    },
    rpc(group: typeof Grayboard) {
      const rpc = host.rpc(group);
      return {
        status: (input: {}, options: { location: { directory: string } }) => run(rpc.status(input, { location: location(options.location) })),
        enroll: (input: { sessionID: string; name?: string; create?: boolean }, options: { location: { directory: string } }) => run(rpc.enroll(input, { location: location(options.location) })),
        pause: (input: {}, options: { location: { directory: string } }) => run(rpc.pause(input, { location: location(options.location) })),
      };
    },
  };
}
export type FixtureHost = Awaited<ReturnType<typeof createFixtureHost>>;
