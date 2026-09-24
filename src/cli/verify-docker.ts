/**
 * Checks the parts of the Docker manager that do not need Docker: the
 * arguments it constructs and the output it parses.
 *
 * These are worth pinning precisely because they are invisible when wrong. A
 * misplaced `-p` binds the game's unauthenticated API to every interface on
 * the machine, and a status parse that reads "exited" as reusable produces a
 * container that is up but has no SC2 in it. Neither shows up as an error;
 * both show up as something subtly worse.
 *
 * Run with: node dist/cli/verify-docker.js
 */
import {
  buildImageArgs,
  createLineSplitter,
  parseContainerStatus,
  runContainerArgs,
  CONTAINER_NAME,
  CONTAINER_PORT,
  HOST_BIND,
  IMAGE_NAME,
  IMAGE_REVISION,
  SECOND_CLIENT_PORT,
  SC2_BUILD,
  SC2_VERSION,
} from "../docker/DockerManager";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

function main(): void {
  // -- the image tag carries the version ----------------------------------
  check("the image tag pins the SC2 version and the image revision", IMAGE_NAME, `sc2-observer:${SC2_VERSION}-${SC2_BUILD}-${IMAGE_REVISION}`);

  const build = buildImageArgs("C:/dev/sc2-observer/docker");
  check("build tags the versioned image", build.includes(IMAGE_NAME), true);
  check("build passes the version as a build arg", build.includes(`SC2_VERSION=${SC2_VERSION}`), true);
  check("build passes the build number as a build arg", build.includes(`SC2_BUILD=${SC2_BUILD}`), true);
  check("build names the Dockerfile explicitly", build.includes("C:/dev/sc2-observer/docker/Dockerfile"), true);
  check("build's last argument is the context", build[build.length - 1], "C:/dev/sc2-observer/docker");

  // -- the port must never leave loopback ---------------------------------
  const run = runContainerArgs("C:\\dev\\sc2-observer\\maps", 5001);
  const portIndex = run.indexOf("-p");
  check("run publishes a port", portIndex >= 0, true);
  check("the published port is bound to loopback", run[portIndex + 1], `${HOST_BIND}:5001:${CONTAINER_PORT}`);
  check("loopback is what HOST_BIND means", HOST_BIND, "127.0.0.1");

  // A non-default host port must not change the container side, or the
  // mapping points at nothing.
  const shifted = runContainerArgs("C:\\maps", 5555);
  check("a shifted host port keeps the container port", shifted[shifted.indexOf("-p") + 1], `${HOST_BIND}:5555:${CONTAINER_PORT}`);

  // -- the Windows host path goes in verbatim ------------------------------
  const volumeIndex = run.indexOf("-v");
  check("the drive-letter host path is not mangled", run[volumeIndex + 1], "C:\\dev\\sc2-observer\\maps:/root/StarCraftII/Maps");
  const spaced = runContainerArgs("C:\\Users\\a b\\maps", 5001);
  check("a path with spaces survives as one argument", spaced[spaced.indexOf("-v") + 1], "C:\\Users\\a b\\maps:/root/StarCraftII/Maps");
  check("run names the container", run[run.indexOf("--name") + 1], CONTAINER_NAME);

  // -- one client by default, two for a game between two bots --------------
  check("one client sets no client count", run.includes("SC2_CLIENTS=2"), false);
  check("one client publishes one port", run.filter((arg) => arg === "-p").length, 1);
  const two = runContainerArgs("C:\\maps", 5001, 2);
  check("two clients ask the entrypoint for two", two[two.indexOf("-e") + 1], "SC2_CLIENTS=2");
  const published = two.flatMap((arg, i) => (arg === "-p" ? [two[i + 1]] : []));
  check("two clients publish both ports, on loopback", published, [
    `${HOST_BIND}:5001:${CONTAINER_PORT}`,
    `${HOST_BIND}:${SECOND_CLIENT_PORT}:${SECOND_CLIENT_PORT}`,
  ]);
  check("the image is still the last argument", two[two.length - 1], IMAGE_NAME);

  // -- status parsing ------------------------------------------------------
  check("running is reusable", parseContainerStatus("running\n", 0), "running");
  check("exited is not", parseContainerStatus("exited\n", 0), "exited");
  check("created is not reusable either", parseContainerStatus("created\n", 0), "exited");
  check("paused is not reusable either", parseContainerStatus("paused\n", 0), "exited");
  check("a failed inspect means no such container", parseContainerStatus("", 1), "missing");
  check("empty output means no such container", parseContainerStatus("\n", 0), "missing");
  check("case does not matter", parseContainerStatus("RUNNING", 0), "running");

  // -- line splitting ------------------------------------------------------
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push("Step 1/3");
  check("a chunk with no newline emits nothing yet", lines.length, 0);
  splitter.push(" : FROM debian\nStep 2/3");
  check("the line completes when its newline arrives", lines, ["Step 1/3 : FROM debian"]);
  splitter.push(" : RUN wget\r\nStep 3/3 : COPY\n");
  check("CRLF is handled like LF", lines, ["Step 1/3 : FROM debian", "Step 2/3 : RUN wget", "Step 3/3 : COPY"]);
  splitter.push("no trailing newline");
  splitter.flush();
  check("flush emits the last unterminated line", lines[lines.length - 1], "no trailing newline");
  splitter.flush();
  check("flushing twice does not repeat it", lines.length, 4);

  const blanks: string[] = [];
  const blankSplitter = createLineSplitter((line) => blanks.push(line));
  blankSplitter.push("a\n\n\nb\n");
  check("blank lines are dropped rather than logged", blanks, ["a", "b"]);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main();
