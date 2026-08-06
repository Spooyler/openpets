import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const KNOWN_PERMISSIONS = [
  "pet:speak", "pet:interact", "pet:move", "pet:pin",
  "schedule", "storage", "commands", "events", "audio", "network",
];

const LOCALES = ["en", "es-419", "ja", "ko", "pt-BR", "zh-Hans", "zh-Hant"];

const ID_PATTERN = /^openpets\.[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

async function main() {
  const id = argv[2];
  if (!id) { console.error("Usage: pnpm create-plugin <id>\nExample: pnpm create-plugin openpets.my-plugin"); process.exit(1); }
  if (!ID_PATTERN.test(id)) { console.error(`Invalid plugin ID: "${id}". Must match openpets.<lowercase-alphanumeric-hyphens>.`); process.exit(1); }

  const pluginDir = resolve("plugins/official", id);
  if (existsSync(pluginDir)) { console.error(`Plugin directory already exists: ${pluginDir}`); process.exit(1); }

  const rl = createInterface({ input: stdin, output: stdout });
  const shortName = id.replace("openpets.", "");

  const displayName = await rl.question("Display name: ");
  if (!displayName.trim()) { console.error("Display name is required."); process.exit(1); }

  const description = await rl.question("Description: ");
  if (!description.trim()) { console.error("Description is required."); process.exit(1); }

  console.log(`\nAvailable permissions: ${KNOWN_PERMISSIONS.join(", ")}`);
  const permInput = await rl.question("Permissions (comma-separated, or empty for none): ");
  const permissions = permInput.trim()
    ? permInput.split(",").map((p) => p.trim()).filter((p) => KNOWN_PERMISSIONS.includes(p))
    : [];

  const includeConfig = (await rl.question("Include config schema example? (y/N): ")).trim().toLowerCase() === "y";
  rl.close();

  const allPermissions = ["pet:speak", "commands", ...permissions.filter((p) => p !== "pet:speak" && p !== "commands")];
  const uniquePermissions = [...new Set(allPermissions)];

  const manifest = {
    manifestVersion: 3,
    id,
    name: "$t:plugin.name",
    description: "$t:plugin.description",
    version: "1.0.0",
    runtime: "javascript",
    icon: "plugin",
    sdkVersion: "3.0.0",
    entry: "index.js",
    assets: { icons: { [shortName]: `assets/${shortName}.svg` } },
    permissions: uniquePermissions,
  };
  if (includeConfig) {
    manifest.configSchema = {
      exampleToggle: {
        type: "boolean",
        default: false,
        label: "$t:config.exampleToggle.label",
        description: "$t:config.exampleToggle.description",
      },
    };
  }

  const indexJs = `export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await ctx.commands.register(
        {
          id: "hello",
          title: "$t:command.hello.title",
          description: "$t:command.hello.description",
          icon: "${shortName}",
        },
        async () => {
          await ctx.pet.speak(ctx.t("speech.hello"));
        },
      );
    },
    async stop() {},
  });
}
`;

  const testJs = `import assert from "node:assert/strict";
import { register } from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(
    new URL("../../../packages/sdk/dist/testing.js", import.meta.url)
  ));
}

const PERMISSIONS = ${JSON.stringify(uniquePermissions)};
const LOCALES = {
  en: JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("./locales/en.json", import.meta.url),
      "utf8",
    ),
  ),
};

const harness = createTestHarness({ permissions: PERMISSIONS, locales: LOCALES });
register(harness.OpenPetsPlugin);
await harness.start();

assert.ok(harness.commands.has("hello"), "hello command should be registered");

await harness.stop();
console.log("All tests passed.");
`;

  const enLocale = {
    "plugin.name": displayName.trim(),
    "plugin.description": description.trim(),
    "command.hello.title": "Say hello",
    "command.hello.description": "Make the pet say hello.",
    "speech.hello": `Hello from ${displayName.trim()}!`,
  };
  if (includeConfig) {
    enLocale["config.exampleToggle.label"] = "Example toggle";
    enLocale["config.exampleToggle.description"] = "An example configuration toggle.";
  }

  const stubLocale = { "plugin.name": displayName.trim(), "plugin.description": description.trim() };

  const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>`;

  await mkdir(join(pluginDir, "assets"), { recursive: true });
  await mkdir(join(pluginDir, "locales"), { recursive: true });
  await writeFile(join(pluginDir, "openpets.plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(pluginDir, "index.js"), indexJs);
  await writeFile(join(pluginDir, "test.js"), testJs);
  await writeFile(join(pluginDir, `assets/${shortName}.svg`), placeholderSvg);
  for (const locale of LOCALES) {
    const content = locale === "en" ? enLocale : stubLocale;
    await writeFile(join(pluginDir, `locales/${locale}.json`), JSON.stringify(content, null, 2) + "\n");
  }

  console.log(`\nPlugin scaffolded at ${pluginDir}`);
  console.log("Next steps:");
  console.log("  1. Edit index.js to add your plugin logic");
  console.log("  2. Run: pnpm plugins:test");
  console.log("  3. Set OPENPETS_DEV_PLUGIN_ROOTS to plugins/official for hot-reload");
}

main().catch((error) => { console.error(error.message); process.exit(1); });
