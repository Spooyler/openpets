import assert from "node:assert/strict";

import { maxPetdexPets, parsePetdexManifest, petdexAssetHost, petdexManifestUrl, validatePetdexAssetUrl } from "../src/petdex-catalog-core.js";

const validEntry = {
  slug: "homelander",
  displayName: "Homelander",
  kind: "character",
  submittedBy: "Serhat",
  spritesheetUrl: "https://assets.petdex.dev/pets/homelander-abc/sprite.webp",
  petJsonUrl: "https://assets.petdex.dev/pets/homelander-abc/petjson.json",
  zipUrl: "https://assets.petdex.dev/pets/homelander-abc/zip.zip",
};

// A valid entry round-trips with trimmed fields.
assert.deepEqual(parsePetdexManifest({ pets: [{ ...validEntry, displayName: " Homelander " }] }), [validEntry]);

// Invalid entries are dropped without failing the whole manifest.
const dropped = parsePetdexManifest({
  pets: [
    validEntry,
    { ...validEntry, slug: "Bad/Slug" },
    { ...validEntry, slug: "http-scheme", spritesheetUrl: "http://assets.petdex.dev/sprite.webp" },
    { ...validEntry, slug: "wrong-host", petJsonUrl: "https://evil.example.com/petjson.json" },
    { ...validEntry, slug: "long-name", displayName: "x".repeat(81) },
    { ...validEntry, slug: "empty-name", displayName: "   " },
    { ...validEntry, slug: "builtin" },
    { ...validEntry },
    "junk",
    null,
  ],
});
assert.deepEqual(dropped, [validEntry]);

// Wholesale-invalid manifests throw (the fetch wrapper maps this to an error state).
assert.throws(() => parsePetdexManifest(null));
assert.throws(() => parsePetdexManifest("nope"));
assert.throws(() => parsePetdexManifest({ pets: "nope" }));

// The entry count is capped.
const many = { pets: Array.from({ length: maxPetdexPets + 10 }, (_, index) => ({ ...validEntry, slug: `pet-${index}` })) };
assert.equal(parsePetdexManifest(many).length, maxPetdexPets);

// Asset URL validation pins scheme and host exactly.
assert.equal(validatePetdexAssetUrl(validEntry.spritesheetUrl), validEntry.spritesheetUrl);
assert.throws(() => validatePetdexAssetUrl("http://assets.petdex.dev/x.webp"));
assert.throws(() => validatePetdexAssetUrl("https://assets.petdex.dev:8443/x.webp"));
assert.throws(() => validatePetdexAssetUrl("https://user:pw@assets.petdex.dev/x.webp"));
assert.throws(() => validatePetdexAssetUrl("https://petdex.dev/x.webp"));
assert.throws(() => validatePetdexAssetUrl("https://sub.assets.petdex.dev/x.webp"));
assert.throws(() => validatePetdexAssetUrl("not a url"));

// The manifest endpoint itself lives on the pinned asset host.
assert.equal(new URL(petdexManifestUrl).hostname, petdexAssetHost);

console.log("Petdex catalog validation passed.");
