#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptsDir, "..");
const repoRoot = resolve(desktopDir, "../..");
const outputDir = join(desktopDir, "dist-electron");
const repository = "alvinunreal/openpets";

const allowedArgs = new Set([
  "--dry-run",
  "--yes",
  "--include-experimental-arm",
  "--skip-checks",
  "--help",
]);
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const unknownArgs = rawArgs.filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length > 0) throw new Error(`Unknown release option(s): ${unknownArgs.join(", ")}`);
const args = new Set(rawArgs);
const dryRun = args.has("--dry-run");
const yes = args.has("--yes");
const includeExperimentalArm = args.has("--include-experimental-arm");
const skipChecks = args.has("--skip-checks");
if (skipChecks && yes) throw new Error("Refusing to create a release with --skip-checks. Run checks before using --yes.");

if (args.has("--help")) {
  printHelp();
  process.exit(0);
}

const desktopPackageJson = readJson(join(desktopDir, "package.json"));
const version = desktopPackageJson.version;
const tag = `v${version}`;

main();

function main() {
  preflight();
  if (!skipChecks) {
    run("pnpm", ["build"], { cwd: repoRoot });
    run("pnpm", ["--filter", "@open-pets/desktop", "check"], { cwd: repoRoot });
  }

  run("node", ["scripts/clean-package-output.cjs"], { cwd: desktopDir });
  mkdirSync(outputDir, { recursive: true });

  for (const build of createBuildPlan()) {
    run("pnpm", ["exec", "electron-builder", ...build.args, "--publish", "never"], { cwd: desktopDir });
  }

  const postBuildStatus = getGitStatusIgnoringPackageOutput();
  if (postBuildStatus) throw new Error(`Build/checks changed tracked or source files. Commit or revert them before releasing.\n${postBuildStatus}`);

  const artifacts = collectArtifacts(outputDir);
  if (artifacts.length === 0) throw new Error("No release artifacts were produced.");
  const checksumsPath = writeChecksums(artifacts);
  const uploadArtifacts = [...artifacts, checksumsPath];

  console.log("\nRelease artifacts:");
  for (const artifact of uploadArtifacts) console.log(`- ${relative(repoRoot, artifact)}`);

  if (!yes && !dryRun) {
    throw new Error("Re-run with --yes to create the draft GitHub release after reviewing the artifact list.");
  }
  if (dryRun) {
    console.log(`\nDry run complete. Would create draft release ${tag} in ${repository}.`);
    return;
  }

  const target = commandOutput("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim();
  run("gh", ["release", "create", tag, "--repo", repository, "--target", target, "--title", `OpenPets ${tag}`, "--notes", defaultReleaseNotes()], { cwd: repoRoot });
  run("gh", ["release", "upload", tag, "--repo", repository, ...uploadArtifacts], { cwd: repoRoot });
  console.log(`\nPublished release created: https://github.com/${repository}/releases/tag/${tag}`);
  console.log("Published releases are visible to the app update checker.");
}

function preflight() {
  if (process.platform !== "darwin") throw new Error("This local release script is intended to run from macOS.");
  if (!isStableSemver(version) || version === "0.0.0") {
    throw new Error(`Desktop package version must be a stable non-zero semver version. Current: ${version}`);
  }
  requireCommand("pnpm", ["--version"]);
  requireCommand("gh", ["--version"]);
  run("gh", ["auth", "status", "--hostname", "github.com"], { cwd: repoRoot });

  const remoteUrl = commandOutput("git", ["remote", "get-url", "origin"], { cwd: repoRoot }).trim();
  if (!remoteUrl.includes(repository)) {
    throw new Error(`Expected origin remote to point at ${repository}. Current origin: ${remoteUrl}`);
  }
  const status = commandOutput("git", ["status", "--porcelain"], { cwd: repoRoot }).trim();
  if (status) throw new Error(`Git working tree must be clean before release.\n${status}`);

  run("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  const upstream = commandOutput("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: repoRoot }).trim();
  if (!upstream) throw new Error("Release branch must have an upstream remote branch.");
  run("git", ["fetch", "--tags", "origin"], { cwd: repoRoot });
  const localHead = commandOutput("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim();
  const remoteHead = commandOutput("git", ["rev-parse", upstream], { cwd: repoRoot }).trim();
  if (localHead !== remoteHead) throw new Error(`HEAD must be pushed to ${upstream} before release.`);

  if (commandSucceeds("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: repoRoot })) {
    throw new Error(`Git tag already exists locally: ${tag}`);
  }
  if (commandSucceeds("git", ["ls-remote", "--exit-code", "--tags", "origin", tag], { cwd: repoRoot })) {
    throw new Error(`Git tag already exists on origin: ${tag}`);
  }
  if (commandSucceeds("gh", ["release", "view", tag, "--repo", repository], { cwd: repoRoot })) {
    throw new Error(`GitHub release already exists: ${tag}`);
  }
}

function createBuildPlan() {
  const plan = [
    { name: "mac dmg x64+arm64", args: ["--mac", "dmg", "--x64", "--arm64"] },
    { name: "mac zip x64+arm64", args: ["--mac", "zip", "--x64", "--arm64"] },
    { name: "windows nsis x64", args: ["--win", "nsis", "--x64"] },
    { name: "linux AppImage x64", args: ["--linux", "AppImage", "--x64"] },
    { name: "linux deb x64", args: ["--linux", "deb", "--x64"] },
    { name: "linux rpm x64", args: ["--linux", "rpm", "--x64"] },
    { name: "linux tar.gz x64", args: ["--linux", "tar.gz", "--x64"] },
  ];
  if (includeExperimentalArm) {
    plan.push({ name: "windows nsis arm64", args: ["--win", "nsis", "--arm64"] });
    plan.push({ name: "linux AppImage arm64", args: ["--linux", "AppImage", "--arm64"] });
  }
  console.log("Build plan:");
  for (const build of plan) console.log(`- ${build.name}`);
  return plan;
}

function collectArtifacts(dir) {
  const allowedNames = new Set(["SHA256SUMS"]);
  const allowedExtensions = new Set([".dmg", ".zip", ".exe", ".AppImage", ".deb", ".rpm"]);
  const artifacts = [];
  for (const entry of readdirSync(dir)) {
    const filePath = join(dir, entry);
    const stat = statSync(filePath);
    if (!stat.isFile()) continue;
    const name = basename(filePath);
    if (allowedNames.has(name) || allowedExtensions.has(extname(name)) || name.endsWith(".tar.gz")) artifacts.push(filePath);
  }
  return artifacts.filter((path) => basename(path) !== "SHA256SUMS").sort();
}

function writeChecksums(artifacts) {
  const lines = artifacts.map((artifact) => `${sha256(artifact)}  ${basename(artifact)}`);
  const checksumsPath = join(outputDir, "SHA256SUMS");
  writeFileSync(checksumsPath, `${lines.join("\n")}\n`);
  return checksumsPath;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function getGitStatusIgnoringPackageOutput() {
  return commandOutput("git", ["status", "--porcelain"], { cwd: repoRoot })
    .split("\n")
    .filter((line) => line.trim() && !line.includes("apps/desktop/dist-electron/"))
    .join("\n");
}

function isStableSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function requireCommand(command, args) {
  if (!commandSucceeds(command, args, { cwd: repoRoot })) throw new Error(`Required command is unavailable: ${command}`);
}

function commandSucceeds(command, args, options) {
  return spawnSync(command, args, { cwd: options.cwd, stdio: "ignore" }).status === 0;
}

function commandOutput(command, args, options) {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function run(command, args, options) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: options.cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
}

function defaultReleaseNotes() {
  const previousTag = commandOutput("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"], { cwd: repoRoot }).trim();
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const commits = commandOutput("git", ["log", "--pretty=format:%h %s", range], { cwd: repoRoot })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return [
    `OpenPets ${tag} desktop release.`,
    "",
    `Changes since ${previousTag || "the initial history"}:`,
    "",
    ...(commits.length > 0 ? commits.map((commit) => `- ${commit}`) : ["- No commits found in the release range."]),
    "",
    "## Artifacts",
    "",
    "This release includes the full desktop artifact set: macOS DMG/ZIP, Windows installer, Linux AppImage/DEB/RPM/tar.gz, and SHA256SUMS.",
    "",
    "## Notes",
    "",
    "Desktop artifacts are currently unsigned, so OS security warnings may appear.",
  ].join("\n");
}

function printHelp() {
  console.log(`Usage: pnpm release:desktop -- --yes\n\nBuilds local desktop release artifacts, creates a published GitHub release, and uploads artifacts.\n\nDefault targets:\n  - macOS dmg x64+arm64\n  - macOS zip x64+arm64\n  - Windows nsis x64\n  - Linux AppImage x64\n  - Linux deb x64\n  - Linux rpm x64\n  - Linux tar.gz x64\n\nOptions:\n  --yes                       create the published GitHub release after building\n  --dry-run                   run checks/builds and print what would be released\n  --skip-checks               skip pnpm build and desktop check\n  --include-experimental-arm  also build Windows/Linux ARM64 artifacts\n`);
}
