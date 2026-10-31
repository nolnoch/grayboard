import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Observe the installed subscriber's actual lifetime; do not stop, replace or short-circuit its work.
export function observeRuns(prototype: object) {
  type Run = (this: unknown, ...args: unknown[]) => Promise<unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "run");
  if (!descriptor || typeof descriptor.value !== "function") throw new Error("Installed subscriber run boundary unavailable");
  const original = descriptor.value as Run;
  const running = new Map<string, Promise<void>>();
  Object.defineProperty(prototype, "run", { ...descriptor, value: function(this: unknown, ...args: unknown[]) {
    const enrollment = args[1] as { sessionID?: unknown };
    if (typeof enrollment?.sessionID !== "string") throw new Error("Installed subscriber root boundary unavailable");
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    running.set(enrollment.sessionID, done);
    try {
      const task = original.apply(this, args);
      void task.then(finish, finish);
      return task;
    } catch (error) { finish(); throw error; }
  } });
  return {
    current(root: string) {
      const task = running.get(root);
      if (!task) throw new Error("No observed subscriber generation for root");
      return task;
    },
    restore() { Object.defineProperty(prototype, "run", descriptor); },
  };
}
export async function observeSubscriberWork(directory: string) {
  const { Controller } = await import(pathToFileURL(join(directory, "src/core/controller.ts")).href);
  return observeRuns(Controller.prototype);
}
export type SubscriberWork = ReturnType<typeof observeRuns>;
