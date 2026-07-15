import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { maxCodexPetJsonBytes, maxCodexSpritesheetBytes, maxCodexThumbnailSourceBytes, validateCodexPetMetadata } from "./codex-pets-core.js";
import { installPetFromFolderWithResult, type LocalPetInstallResult } from "./pet-installation.js";
import { maxPetdexManifestBytes, parsePetdexManifest, petdexManifestUrl, type PetdexManifestEntry } from "./petdex-catalog-core.js";

const manifestTtlMs = 5 * 60_000;
const fetchTimeoutMs = 10_000;
const maxPreviewBatchSize = 24;
const maxPreviewCacheEntries = 200;

export interface PetdexUiState {
  readonly source: "petdex";
  readonly pets: readonly PetdexUiItem[];
  readonly error?: string;
}

export interface PetdexUiItem {
  readonly slug: string;
  readonly displayName: string;
  readonly kind: string;
  readonly submittedBy: string;
}

let manifestCache: { readonly at: number; readonly entries: readonly PetdexManifestEntry[] } | undefined;
// Insertion-ordered map doubling as an LRU: re-inserting on hit refreshes recency.
const previewCache = new Map<string, string>();

export async function getPetdexUiState(): Promise<PetdexUiState> {
  try {
    const entries = await loadManifestEntries();
    return { source: "petdex", pets: entries.map(({ slug, displayName, kind, submittedBy }) => ({ slug, displayName, kind, submittedBy })) };
  } catch (error) {
    return { source: "petdex", pets: [], error: error instanceof Error ? error.message : "Petdex catalog unavailable." };
  }
}

export async function getPetdexPreviews(slugs: unknown): Promise<Record<string, string>> {
  if (!Array.isArray(slugs) || slugs.length === 0 || slugs.length > maxPreviewBatchSize) throw new Error("Petdex preview request is invalid.");
  const entries = await loadManifestEntries();
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const previews: Record<string, string> = {};

  await Promise.all(slugs.map(async (slug) => {
    if (typeof slug !== "string") return;
    const entry = bySlug.get(slug);
    if (!entry) return;
    const cached = readPreviewCache(slug);
    if (cached !== undefined) {
      previews[slug] = cached;
      return;
    }
    try {
      const spritesheet = await fetchLimitedBytes(entry.spritesheetUrl, maxCodexThumbnailSourceBytes);
      const preview = await createPetdexThumbnailDataUrl(spritesheet);
      if (!preview) return;
      writePreviewCache(slug, preview);
      previews[slug] = preview;
    } catch {
      // A missing thumbnail keeps the placeholder tile; never fail the batch.
    }
  }));

  return previews;
}

export async function installPetdexPet(slug: unknown): Promise<LocalPetInstallResult> {
  if (typeof slug !== "string" || slug.length === 0) throw new Error("Petdex pet slug is invalid.");
  const entries = await loadManifestEntries();
  const entry = entries.find((candidate) => candidate.slug === slug);
  if (!entry) throw new Error("Petdex pet was not found in the catalog.");

  const petJsonBytes = await fetchLimitedBytes(entry.petJsonUrl, maxCodexPetJsonBytes);
  const parsed = JSON.parse(petJsonBytes.toString("utf8")) as unknown;
  // The manifest slug is authoritative: a pet.json whose id differs is rejected.
  const metadata = validateCodexPetMetadata(parsed, entry.slug);
  const spritesheet = await fetchLimitedBytes(entry.spritesheetUrl, maxCodexSpritesheetBytes);

  // realpath: OS temp dirs can be non-canonical on Windows (8.3 short names),
  // and the folder installer requires a canonical path.
  const tempDir = await realpath(await mkdtemp(join(tmpdir(), "openpets-petdex-")));
  try {
    await writeFile(join(tempDir, "pet.json"), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await writeFile(join(tempDir, "spritesheet.webp"), spritesheet, { mode: 0o600, flag: "wx" });
    return await installPetFromFolderWithResult(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function loadManifestEntries(): Promise<readonly PetdexManifestEntry[]> {
  if (manifestCache && Date.now() - manifestCache.at < manifestTtlMs) return manifestCache.entries;
  const body = await fetchLimitedBytes(petdexManifestUrl, maxPetdexManifestBytes);
  const entries = parsePetdexManifest(JSON.parse(body.toString("utf8")) as unknown);
  manifestCache = { at: Date.now(), entries };
  return entries;
}

async function fetchLimitedBytes(url: string, maxBytes: number): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
    });

    if (new URL(response.url).href !== url) throw new Error("Petdex final URL is not allowed.");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Petdex response body is unavailable for bounded reading.");

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Petdex response is too large.");
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timeout);
  }
}

async function createPetdexThumbnailDataUrl(spritesheet: Buffer): Promise<string> {
  const image = sharp(spritesheet, { limitInputPixels: 50_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) return "";
  const width = Math.min(192, metadata.width);
  const height = Math.min(208, metadata.height);
  const thumbnail = await sharp(spritesheet, { limitInputPixels: 50_000_000 })
    .extract({ left: 0, top: 0, width, height })
    .resize(54, 58, { fit: "fill" })
    .png()
    .toBuffer();
  return `data:image/png;base64,${thumbnail.toString("base64")}`;
}

function readPreviewCache(slug: string): string | undefined {
  const cached = previewCache.get(slug);
  if (cached === undefined) return undefined;
  previewCache.delete(slug);
  previewCache.set(slug, cached);
  return cached;
}

function writePreviewCache(slug: string, preview: string): void {
  previewCache.set(slug, preview);
  while (previewCache.size > maxPreviewCacheEntries) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.delete(oldest);
  }
}
