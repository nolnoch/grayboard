import { spawn } from "node:child_process";

// Opens `url` in the system browser, detached. A missing opener (no
// xdg-open) reports through `failed` instead of an unhandled error event,
// which would crash a host process such as pi. Node APIs only: harness
// adapter bundles run it under Node.
export function openBrowser(url: string, failed: (error: Error) => void = () => {}): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
  child.on("error", failed);
  child.unref();
}
