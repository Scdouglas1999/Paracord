#!/usr/bin/env node
// Builds `paracord-host` and stages it where Tauri's `bundle.externalBin`
// expects it: client/src-tauri/binaries/paracord-host-<target-triple>[.exe]
// (docs/setup-spec.md §2.1).
//
//   npm run host:stage                          debug build for this machine (dev)
//   npm run host:stage -- --release             size-optimized build (profile `host`)
//   npm run host:stage -- --release --target T  cross/explicit target triple
//   npm run host:stage -- --placeholder         a marked stand-in so compile-only
//                                               jobs (check, clippy) can build the
//                                               desktop crate; build.rs refuses it
//                                               in a release build
//
// There is no fallback: a failed build is a failed stage.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "..");
const repoRoot = path.resolve(clientDir, "..");
const binariesDir = path.join(clientDir, "src-tauri", "binaries");
export const PLACEHOLDER_MARKER = "PARACORD-HOST-PLACEHOLDER";

function fail(message) {
  console.error(`host:stage: ${message}`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error) fail(`could not run ${cmd}: ${result.error.message}`);
  return result;
}

function parseArgs(argv) {
  const opts = { release: false, placeholder: false, target: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--release") opts.release = true;
    else if (arg === "--placeholder") opts.placeholder = true;
    else if (arg === "--target") {
      opts.target = argv[++i];
      if (!opts.target) fail("--target needs a triple");
    } else if (arg.startsWith("--target=")) opts.target = arg.slice("--target=".length);
    else fail(`unknown argument ${arg} (see the header of scripts/stage-host-sidecar.mjs)`);
  }
  if (opts.placeholder && opts.release) fail("--placeholder and --release cannot be combined");
  return opts;
}

function hostTriple() {
  const out = run("rustc", ["-vV"]);
  const match = out.status === 0 && /^host:\s*(\S+)/m.exec(out.stdout);
  if (!match) fail("could not read the host triple from `rustc -vV`");
  return match[1];
}

function targetDirectory() {
  const out = run("cargo", ["metadata", "--format-version", "1", "--no-deps"]);
  if (out.status !== 0) fail(`cargo metadata failed:\n${out.stderr}`);
  return JSON.parse(out.stdout).target_directory;
}

const opts = parseArgs(process.argv.slice(2));
const triple = opts.target ?? hostTriple();
const exe = triple.includes("windows") ? ".exe" : "";
const staged = path.join(binariesDir, `paracord-host-${triple}${exe}`);
mkdirSync(binariesDir, { recursive: true });

if (opts.placeholder) {
  writeFileSync(
    staged,
    `${PLACEHOLDER_MARKER}\nThis is not a server. It exists so check/clippy can compile the desktop crate.\n` +
      "Run `npm run host:stage` for a real one.\n",
  );
  console.log(`host:stage: wrote a placeholder at ${staged}`);
  process.exit(0);
}

// The binary embeds the web UI at compile time.
if (!existsSync(path.join(clientDir, "dist", "index.html"))) {
  fail("client/dist is missing: run `npm run build` first (paracord-host embeds the web UI)");
}

const profile = opts.release ? "host" : "debug";
const cargoArgs = ["build", "--bin", "paracord-host"];
if (opts.release) cargoArgs.push("--profile", "host", "--locked");
if (opts.target) cargoArgs.push("--target", opts.target);
console.log(`host:stage: cargo ${cargoArgs.join(" ")}`);
const build = run("cargo", cargoArgs, { stdio: "inherit" });
if (build.status !== 0) fail("cargo build --bin paracord-host failed");

const built = path.join(targetDirectory(), ...(opts.target ? [opts.target] : []), profile, `paracord-host${exe}`);
if (!existsSync(built)) fail(`cargo succeeded but ${built} does not exist`);
copyFileSync(built, staged);
if (!exe) chmodSync(staged, 0o755);
const size = statSync(staged).size;
if (size < 1_000_000) fail(`${staged} is only ${size} bytes: not a real server`);
console.log(`host:stage: staged ${staged} (${(size / 1048576).toFixed(1)} MiB, ${profile})`);
