import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isUnderPath } from "./plugin-manifest-reader.js";

export async function resolveSafePluginInstallDir(userDataPath: string, id: string, installPath: string, source: "bundled" | "local"): Promise<string> { const root = join(userDataPath, source === "bundled" ? "plugins" : "plugins-dev"); await assertDir(root); const stat = await fs.lstat(installPath); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Plugin install directory is invalid."); const realRoot = await fs.realpath(root); const realInstall = await fs.realpath(installPath); if (!isUnderPath(realInstall, realRoot) || realInstall !== join(realRoot, id)) throw new Error("Refusing to delete unexpected plugin directory."); return realInstall; }

export async function safeDeletePluginInstallDir(userDataPath: string, id: string, installPath: string, source: "bundled" | "local"): Promise<void> { const realInstall = await resolveSafePluginInstallDir(userDataPath, id, installPath, source); await fs.rm(realInstall, { recursive: true, force: true }); }

async function assertDir(path: string): Promise<void> { const stat = await fs.lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Plugin directory is invalid."); }
