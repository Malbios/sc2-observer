import { spawn } from "node:child_process";
import WebSocket from "ws";
import type { EventBus } from "../bus/EventBus";

/**
 * Owns the SC2 container (plan §4).
 *
 * Drives the `docker` CLI rather than the Engine API, per §5: dockerode would
 * avoid parsing CLI output, but on Windows its named-pipe setup is a second
 * thing to verify and nothing here needs more than build/run/stop/logs.
 *
 * It does not assume the container survives between games. §7.1 lists that as
 * something to verify rather than believe, and Phase 0 verified it does, so
 * `ensureClientReady` reuses a healthy container instead of recreating one:
 * restarting the client costs about twenty seconds of SC2 boot for nothing.
 */

/**
 * The image version is declared here, not in the Dockerfile, and passed as a
 * build argument. The Dockerfile's own ARG defaults exist for a manual
 * `docker build`; if the two ever disagree this one wins, and because the tag
 * carries the version a change cannot silently reuse the old image.
 *
 * 4.10 / 75689 is the last Linux headless build Blizzard published. See
 * CLAUDE.md before considering a change.
 */
export const SC2_VERSION = "4.10";
export const SC2_BUILD = "75689";

export const IMAGE_NAME = `sc2-observer:${SC2_VERSION}-${SC2_BUILD}`;
export const CONTAINER_NAME = "sc2-observer";

/** SC2 listens here inside the container; entrypoint.sh passes `-port 5001`. */
export const CONTAINER_PORT = 5001;

/** Published to loopback only. The game API is unauthenticated, so binding it
 * to any external interface would put a remote-control socket on the network. */
export const HOST_BIND = "127.0.0.1";

const MAPS_MOUNT = "/root/StarCraftII/Maps";

export type ContainerStatus = "running" | "exited" | "missing";

export interface DockerManagerOptions {
  bus: EventBus;
  /** Folder holding the Dockerfile; also the build context. */
  dockerfileDir: string;
  /** Host maps folder, mounted so the client can find the map to create. */
  mapsDir: string;
  hostPort?: number;
}

export interface DockerAvailability {
  available: boolean;
  /** Server version when the daemon answered, else null. */
  version: string | null;
  /** Why it is unavailable, in words a user can act on. */
  reason: string | null;
}

// -- pure helpers, so the interesting parts are testable without Docker -----

export function buildImageArgs(dockerfileDir: string): string[] {
  return [
    "build",
    "-t",
    IMAGE_NAME,
    "--build-arg",
    `SC2_VERSION=${SC2_VERSION}`,
    "--build-arg",
    `SC2_BUILD=${SC2_BUILD}`,
    "-f",
    `${dockerfileDir}/Dockerfile`,
    dockerfileDir,
  ];
}

/**
 * The host path goes in verbatim. §7.1 flagged the `-v` host-path form on
 * Windows Docker Desktop as something to test rather than copy from the
 * VS Code extension (which strips a colon out of its own URI form); the
 * drive-letter form is what Phase 0 proved works.
 */
export function runContainerArgs(mapsDir: string, hostPort: number): string[] {
  return [
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-p",
    `${HOST_BIND}:${hostPort}:${CONTAINER_PORT}`,
    "-v",
    `${mapsDir}:${MAPS_MOUNT}`,
    IMAGE_NAME,
  ];
}

/**
 * `docker inspect -f {{.State.Status}}` prints one of Docker's own status
 * words, or fails when there is no such container. Anything that is not
 * running is treated as `exited`, because the only decision that depends on
 * this is "can it be reused, or must it be replaced".
 */
export function parseContainerStatus(stdout: string, exitCode: number): ContainerStatus {
  if (exitCode !== 0) return "missing";
  const status = stdout.trim().toLowerCase();
  if (status === "") return "missing";
  return status === "running" ? "running" : "exited";
}

/**
 * Splits a byte stream into whole lines across chunk boundaries. A partial
 * trailing line is held until the rest of it arrives, so a progress line is
 * never reported in halves.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let partial = "";
  return {
    push(chunk: string): void {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line !== "") onLine(line);
      }
    },
    flush(): void {
      if (partial !== "") onLine(partial);
      partial = "";
    },
  };
}

// -- the manager -----------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class DockerManager {
  private readonly bus: EventBus;
  private readonly dockerfileDir: string;
  private readonly mapsDir: string;
  readonly hostPort: number;
  private logStream: { stop(): void } | null = null;

  constructor(options: DockerManagerOptions) {
    this.bus = options.bus;
    this.dockerfileDir = options.dockerfileDir;
    this.mapsDir = options.mapsDir;
    this.hostPort = options.hostPort ?? CONTAINER_PORT;
  }

  get clientUrl(): string {
    return `ws://${HOST_BIND}:${this.hostPort}/sc2api`;
  }

  private log(source: "manager" | "build" | "container", line: string): void {
    this.bus.emit("dockerLog", { source, line });
  }

  /** Runs `docker` to completion and collects its output. Never throws: a
   * missing `docker` binary is a state to report, not an exception to chase
   * up through the session controller. */
  private run(args: string[]): Promise<RunResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const child = spawn("docker", args, { windowsHide: true });
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  /** Runs `docker` and streams both its streams line by line, for the long
   * commands whose output is the only sign of progress. */
  private runStreaming(args: string[], source: "build" | "container"): Promise<number> {
    return new Promise((resolve) => {
      const splitter = createLineSplitter((line) => this.log(source, line));
      const child = spawn("docker", args, { windowsHide: true });
      // Docker writes build progress to stderr, so both streams are the log.
      child.stdout.on("data", (chunk: Buffer) => splitter.push(chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => splitter.push(chunk.toString()));
      child.on("error", (err) => {
        this.log(source, err.message);
        resolve(-1);
      });
      child.on("close", (code) => {
        splitter.flush();
        resolve(code ?? -1);
      });
    });
  }

  async detect(): Promise<DockerAvailability> {
    const result = await this.run(["version", "--format", "{{.Server.Version}}"]);
    if (result.code === 0) {
      return { available: true, version: result.stdout.trim(), reason: null };
    }
    // Two different failures a user fixes two different ways.
    const missingBinary = /ENOENT|not recognized|not found/i.test(result.stderr);
    return {
      available: false,
      version: null,
      reason: missingBinary
        ? "Docker was not found on PATH. Install Docker Desktop."
        : `The Docker daemon did not respond. Is Docker Desktop running? (${result.stderr.trim().split("\n")[0] ?? ""})`,
    };
  }

  async imageExists(): Promise<boolean> {
    const result = await this.run(["image", "inspect", IMAGE_NAME]);
    return result.code === 0;
  }

  async containerStatus(): Promise<ContainerStatus> {
    const result = await this.run(["inspect", "-f", "{{.State.Status}}", CONTAINER_NAME]);
    return parseContainerStatus(result.stdout, result.code);
  }

  /** Several gigabytes on a cold cache, seconds on a warm one. The output is
   * streamed because a silent multi-minute wait is indistinguishable from a
   * hang. */
  async buildImage(): Promise<boolean> {
    this.log("manager", `building ${IMAGE_NAME} (this takes a while the first time)`);
    const code = await this.runStreaming(buildImageArgs(this.dockerfileDir), "build");
    if (code !== 0) {
      this.log("manager", `build failed with exit code ${code}`);
      return false;
    }
    this.log("manager", "build finished");
    return true;
  }

  async removeContainer(): Promise<void> {
    await this.run(["rm", "-f", CONTAINER_NAME]);
  }

  async startContainer(): Promise<boolean> {
    const result = await this.run(runContainerArgs(this.mapsDir, this.hostPort));
    if (result.code !== 0) {
      this.log("manager", `docker run failed: ${result.stderr.trim()}`);
      return false;
    }
    this.log("manager", `container ${CONTAINER_NAME} started on ${HOST_BIND}:${this.hostPort}`);
    return true;
  }

  async stopContainer(): Promise<void> {
    this.stopLogStream();
    this.log("manager", `stopping ${CONTAINER_NAME}`);
    await this.run(["rm", "-f", CONTAINER_NAME]);
  }

  /** Follows container stdout until stopped. Safe to call twice. */
  streamLogs(): void {
    if (this.logStream) return;
    const splitter = createLineSplitter((line) => this.log("container", line));
    const child = spawn("docker", ["logs", "-f", "--tail", "200", CONTAINER_NAME], { windowsHide: true });
    child.stdout.on("data", (chunk: Buffer) => splitter.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => splitter.push(chunk.toString()));
    child.on("error", () => undefined);
    this.logStream = {
      stop: () => {
        child.kill();
        splitter.flush();
      },
    };
  }

  stopLogStream(): void {
    this.logStream?.stop();
    this.logStream = null;
  }

  /**
   * Opens and closes a socket until the client answers. This is the only
   * honest readiness signal: the container is "running" the moment Docker
   * returns, but SC2 takes a good while longer to accept connections, and
   * there is no healthcheck in the image to ask.
   */
  async waitForClient(timeoutMs = 120_000, intervalMs = 1_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    for (;;) {
      const reachable = await this.probeOnce();
      if (reachable) return true;
      if (Date.now() > deadline) {
        this.log("manager", `SC2 did not accept a connection within ${timeoutMs}ms`);
        return false;
      }
      if (!announced) {
        this.log("manager", "waiting for SC2 to accept connections...");
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private probeOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.clientUrl);
      const settle = (ready: boolean): void => {
        ws.removeAllListeners();
        try {
          ws.close();
        } catch {
          // Already closing; the answer is what matters, not the teardown.
        }
        resolve(ready);
      };
      ws.once("open", () => settle(true));
      ws.once("error", () => settle(false));
    });
  }

  /**
   * The whole cold-start path in one call: Docker present, image built,
   * container up, client answering. Returns the first thing that was wrong so
   * the UI can say which, rather than a bare false.
   */
  async ensureClientReady(): Promise<{ ok: boolean; reason: string | null }> {
    const availability = await this.detect();
    if (!availability.available) return { ok: false, reason: availability.reason };
    this.log("manager", `docker ${availability.version}`);

    if (!(await this.imageExists())) {
      if (!(await this.buildImage())) return { ok: false, reason: "The image could not be built; see the log." };
    }

    const status = await this.containerStatus();
    if (status === "exited") {
      // A stopped container cannot be restarted into a usable state reliably:
      // SC2 has already exited inside it. Replace it.
      this.log("manager", "removing a stopped container");
      await this.removeContainer();
    }
    if (status !== "running") {
      if (!(await this.startContainer())) return { ok: false, reason: "The container could not be started; see the log." };
    } else {
      this.log("manager", "reusing the running container");
    }

    this.streamLogs();
    if (!(await this.waitForClient())) {
      return { ok: false, reason: "SC2 started but never accepted a connection; see the log." };
    }
    this.log("manager", "SC2 is ready");
    return { ok: true, reason: null };
  }
}
