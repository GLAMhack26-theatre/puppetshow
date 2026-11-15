#!/usr/bin/env node
// Writes a software bill of materials with licences: sbom.cdx.json
// (CycloneDX 1.6) and SBOM.md (a readable table), both in the repo root.
//
//   node scripts/sbom.mjs
//
// npm packages come from package-lock.json (direct and transitive, runtime
// and dev). Where the lockfile has no SPDX licence, LICENSE_OVERRIDES holds
// what the package's own LICENSE file says (checked by hand). Fonts, media,
// models and runtime downloads are not npm packages: they are listed in
// ASSETS. Nothing is fetched; run it again after `npm install`.

import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const lock = JSON.parse(await readFile(new URL("package-lock.json", ROOT), "utf8"));
const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));

/** Lockfile licence missing or "SEE LICENSE IN LICENSE": read from the package's LICENSE file. */
const LICENSE_OVERRIDES = {
  "@pmndrs/handle": { id: "MIT" },
  "@pmndrs/pointer-events": { id: "MIT" },
  "@pmndrs/uikit": { id: "MIT" },
  "@pmndrs/uikit-horizon": { id: "MIT" },
  "@pmndrs/uikit-lucide": { id: "MIT" },
  // Code under Apache-2.0, redistributed Google Fonts (Inter, Open Sans, …) under OFL
  "@pmndrs/msdfonts": { expression: "Apache-2.0 AND OFL-1.1" },
  // Declares no licence: not in package.json, no LICENSE file, none on GitHub (drawcall-ai/uikitml)
  "@drawcall/uikitml": { unknown: "no licence declared by the package (pulled in by @iwsdk/core)" },
};

/** Not from npm. scope "required": shipped with the app; "external": loaded from elsewhere at runtime, not redistributed. */
const ASSETS = [
  {
    type: "data", name: "Geist, Geist Serif", supplier: "Vercel", version: "Geist-Variable, GeistSerif-Regular",
    license: { id: "OFL-1.1" }, scope: "required", where: "assets/fonts/",
    url: "https://github.com/vercel/geist-font",
  },
  {
    type: "data", name: "50 RPG sound effects", supplier: "Kenney", license: { id: "CC0-1.0" }, scope: "required",
    where: "assets/sounds/opengameart.org/RPGsounds_Kenney.zip", url: "https://opengameart.org/content/50-rpg-sound-effects",
  },
  {
    type: "data", name: "75 CC0 breaking, falling and hit SFX", supplier: "rubberduck", license: { id: "CC0-1.0" }, scope: "required",
    where: "assets/sounds/opengameart.org/sfx_breaking_and_falling.zip",
    url: "https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx",
  },
  {
    type: "data", name: "Karussell (carousel music, presentation slide 4)", supplier: "GLAMhack26 theatre team",
    license: { name: "Own work of the project team" }, scope: "required", where: "assets/presentation/karussell.m4a",
  },
  {
    type: "data", name: "Frog Legs: Ragtime Era Favorites", supplier: "Kazoomzoom (archive.org kzz003)",
    license: { name: "CC BY-NC-SA 3.0 US", url: "http://creativecommons.org/licenses/by-nc-sa/3.0/us/" },
    scope: "external", where: "streamed from archive.org (assets/sounds/archive.json)", url: "https://archive.org/details/kzz003",
  },
  {
    type: "data", name: "Um Perto II / Cosmic Partchworks", supplier: "Humberto Luis Schenone (archive.org ca364_hls)",
    license: { id: "CC-BY-NC-ND-3.0" }, scope: "external", where: "streamed from archive.org (assets/sounds/archive.json)",
    url: "https://archive.org/details/ca364_hls",
  },
  {
    type: "data", name: "Bigfrogs", supplier: "Asaguare (archive.org Bigfrogs)", license: { id: "CC-BY-NC-SA-3.0" },
    scope: "external", where: "streamed from archive.org (assets/sounds/archive.json)", url: "https://archive.org/details/Bigfrogs",
  },
  {
    type: "data", name: "Ein Haus das klingt", supplier: "Oda Klonk (archive.org OdaKlonkEinHausDasKlingt)",
    license: { id: "CC-BY-NC-ND-3.0" }, scope: "external", where: "excerpts streamed from archive.org (assets/sounds/archive.json)",
    url: "https://archive.org/details/OdaKlonkEinHausDasKlingt",
  },
  {
    type: "data", name: "MediaPipe hand_landmarker.task, gesture_recognizer.task", supplier: "Google",
    license: { id: "Apache-2.0" }, scope: "required", where: "public/mediapipe/ (scripts/fetch-mediapipe-models.sh)",
    url: "https://storage.googleapis.com/mediapipe-models",
  },
  {
    type: "library", name: "Draco glTF decoder (from three.js examples)", supplier: "Google",
    license: { id: "Apache-2.0" }, scope: "required", where: "served under /draco/ from node_modules/three/examples/jsm/libs/draco",
    url: "https://github.com/google/draco",
  },
  {
    type: "data", name: "SKKG collection models and photos", supplier: "Stiftung für Kunst, Kultur und Geschichte (SKKG)",
    license: { unknown: "terms of digital.skkg.ch not recorded in the repo" }, scope: "required",
    where: "assets/digital.skkg.ch/, assets/stage_parts/, export/", url: "https://digital.skkg.ch",
  },
  {
    type: "data", name: "Microscope ETHZ GEOB 0055 (IIIF manifest, model)", supplier: "ETH Zürich",
    license: { unknown: "see the IIIF manifest's rights statement" }, scope: "external",
    where: "loaded from the IIIF manifest's server (IIIFManifests/)",
  },
];

const nameOf = (path, entry) => entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
const direct = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);

function licenceOf(name, declared) {
  const override = LICENSE_OVERRIDES[name];
  if (override) return { ...override, source: "LICENSE file (checked by hand)" };
  if (!declared || /^SEE LICEN[CS]E/i.test(declared)) return { unknown: `lockfile: ${declared ?? "none"}` };
  return /\s(AND|OR|WITH)\s|[()]/.test(declared) ? { expression: declared } : { id: declared };
}

const packages = Object.entries(lock.packages)
  .filter(([path]) => path)
  .map(([path, entry]) => {
    const name = nameOf(path, entry);
    return {
      name,
      version: entry.version,
      licence: licenceOf(name, entry.license),
      dev: !!entry.dev,
      optional: !!entry.optional,
      direct: direct.has(name),
      platform: entry.os?.join(", "),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const label = (l) => l.id ?? l.expression ?? l.name ?? `unknown (${l.unknown})`;

function cdxLicences(l) {
  if (l.expression) return [{ expression: l.expression }];
  if (l.id) return [{ license: { id: l.id } }];
  if (l.name) return [{ license: { name: l.name, ...(l.url ? { url: l.url } : {}) } }];
  return [{ license: { name: "NOASSERTION", text: { content: l.unknown } } }];
}

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: "application", name: "scripts/sbom.mjs" }] },
    component: { type: "application", name: pkg.name, version: pkg.version, "bom-ref": `app:${pkg.name}` },
  },
  components: [
    ...packages.map((p) => ({
      type: "library",
      "bom-ref": `pkg:npm/${p.name}@${p.version}`,
      name: p.name,
      version: p.version,
      purl: `pkg:npm/${p.name.replace(/^@/, "%40")}@${p.version}`,
      scope: p.dev ? "excluded" : p.optional ? "optional" : "required",
      licenses: cdxLicences(p.licence),
      properties: [
        { name: "puppetshow:dependency", value: p.direct ? "direct" : "transitive" },
        { name: "puppetshow:kind", value: p.dev ? "dev (build tools, not shipped)" : "runtime" },
        ...(p.platform ? [{ name: "puppetshow:platform", value: p.platform }] : []),
      ],
    })),
    ...ASSETS.map((a, i) => ({
      type: a.type,
      "bom-ref": `asset:${i}`,
      name: a.name,
      ...(a.version ? { version: a.version } : {}),
      supplier: { name: a.supplier },
      scope: a.scope === "external" ? "optional" : a.scope,
      licenses: cdxLicences(a.license),
      ...(a.url ? { externalReferences: [{ type: "website", url: a.url }] } : {}),
      properties: [
        { name: "puppetshow:location", value: a.where },
        ...(a.scope === "external" ? [{ name: "puppetshow:distribution", value: "loaded at runtime, not redistributed" }] : []),
      ],
    })),
  ],
};

// Readable summary
const runtime = packages.filter((p) => !p.dev);
const dev = packages.filter((p) => p.dev);
const count = (list) =>
  Object.entries(list.reduce((c, p) => ((c[label(p.licence)] = (c[label(p.licence)] ?? 0) + 1), c), {}))
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `| ${l} | ${n} |`)
    .join("\n");
const row = (p) =>
  `| ${p.name} | ${p.version} | ${label(p.licence)} | ${p.direct ? "direct" : "transitive"}${p.optional ? ", optional" : ""}${p.platform ? ` (${p.platform})` : ""} |`;
const unknown = [...packages.filter((p) => p.licence.unknown).map((p) => `${p.name} ${p.version}: ${p.licence.unknown}`),
  ...ASSETS.filter((a) => a.license.unknown).map((a) => `${a.name}: ${a.license.unknown}`)];

const md = `# SBOM: ${pkg.name} ${pkg.version}

Generated by \`node scripts/sbom.mjs\` from \`package-lock.json\` and the asset list in the script. Machine-readable: \`sbom.cdx.json\` (CycloneDX 1.6).

${packages.length} npm packages (${runtime.length} runtime, ${dev.length} dev) and ${ASSETS.length} fonts, media, models and downloads.

## To check

${unknown.map((u) => `- ${u}`).join("\n")}
- Non-commercial licences (CC BY-NC-*): the archive.org music and excerpts are streamed, not redistributed; their use is fine for the hackathon, not for commercial use.

## Licences, runtime npm packages

| Licence | Packages |
|---|---|
${count(runtime)}

## Licences, dev npm packages (build tools, not shipped)

| Licence | Packages |
|---|---|
${count(dev)}

## Fonts, media, models, downloads

| Component | Supplier | Licence | Where | Shipped |
|---|---|---|---|---|
${ASSETS.map((a) => `| ${a.name} | ${a.supplier} | ${label(a.license)} | ${a.where} | ${a.scope === "required" ? "yes" : a.scope === "external" ? "no, loaded at runtime" : "no"} |`).join("\n")}

## Runtime npm packages

| Package | Version | Licence | Dependency |
|---|---|---|---|
${runtime.map(row).join("\n")}

## Dev npm packages

| Package | Version | Licence | Dependency |
|---|---|---|---|
${dev.map(row).join("\n")}
`;

await writeFile(new URL("sbom.cdx.json", ROOT), JSON.stringify(bom, null, 2) + "\n");
await writeFile(new URL("SBOM.md", ROOT), md);
console.log(`sbom.cdx.json, SBOM.md: ${packages.length} npm packages, ${ASSETS.length} assets, ${unknown.length} to check`);
