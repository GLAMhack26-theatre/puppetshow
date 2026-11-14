#!/usr/bin/env node
// Re-indexes assets/sounds/archive.json from archive.org: for every item of
// the playlists and excerpts it reads https://archive.org/metadata/<item>
// and writes the tracks (file, title, creator, licence) and the credits.
// Hand-written fields (plays, playlist items, excerpt times and labels) are
// kept. Items without a licence are left out of the playlists, with a warning.
//
//   node scripts/index-archive.mjs

import { readFile, writeFile } from "node:fs/promises";

const PATH = new URL("../assets/sounds/archive.json", import.meta.url);
const data = JSON.parse(await readFile(PATH, "utf8"));

const cache = new Map();
async function item(id) {
  if (!cache.has(id)) {
    const response = await fetch(`https://archive.org/metadata/${id}`);
    if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
    cache.set(id, await response.json());
  }
  return cache.get(id);
}

/** "http://creativecommons.org/licenses/by-nc-sa/3.0/us/" → "CC BY-NC-SA 3.0 US" */
function licenceLabel(url) {
  const match = url?.match(/creativecommons\.org\/(licenses|publicdomain)\/([^/]+)\/([^/]+)\/?([^/]*)/);
  if (!match) return url ?? null;
  if (match[1] === "publicdomain") return match[2] === "zero" ? "CC0" : "Public Domain";
  return `CC ${match[2].toUpperCase()} ${match[3]}${match[4] ? " " + match[4].toUpperCase() : ""}`;
}

/** "03_-_Sasha_Ponkratov_-_Morning" / "01 - Apertura" / "James Scott - Frog Legs Rag (…)" → the bare title */
function cleanTitle(title, creator) {
  let t = title.replace(/_/g, " ").replace(/^\d+\s*-?\s*/, "").trim();
  if (creator && t.toLowerCase().startsWith(`${creator.toLowerCase()} - `)) t = t.slice(creator.length + 3);
  return t;
}

/** One MP3 per track: the uploaded MP3 if there is one, otherwise archive.org's VBR MP3 derivative. */
function mp3s(files) {
  const mp3 = files.filter((f) => f.name.toLowerCase().endsWith(".mp3"));
  const originals = mp3.filter((f) => f.source === "original");
  return originals.length ? originals : mp3.filter((f) => f.format === "VBR MP3");
}

function credit(id, metadata) {
  const m = metadata.metadata;
  return {
    album: m.title,
    url: `https://archive.org/details/${id}`,
    licence: licenceLabel(m.licenseurl),
    licenceUrl: m.licenseurl ?? null,
  };
}

for (const [name, playlist] of Object.entries(data.playlists)) {
  playlist.tracks = [];
  for (const id of playlist.items) {
    const metadata = await item(id);
    const itemCredit = credit(id, metadata);
    if (!itemCredit.licenceUrl) {
      console.warn(`! ${name}: ${id} has no licence, left out`);
      continue;
    }
    for (const file of mp3s(metadata.files)) {
      const creator = file.creator ?? file.artist ?? metadata.metadata.creator;
      playlist.tracks.push({
        item: id,
        file: file.name,
        title: cleanTitle(file.title ?? file.name.replace(/\.mp3$/i, ""), creator),
        creator,
        licence: itemCredit.licence,
        url: itemCredit.url,
      });
    }
    console.log(`${name}: ${id}, ${playlist.tracks.length} tracks`);
  }
}

for (const excerpt of data.excerpts) {
  const metadata = await item(excerpt.item);
  const [file] = mp3s(metadata.files);
  const itemCredit = credit(excerpt.item, metadata);
  if (!itemCredit.licenceUrl) console.warn(`! excerpt ${excerpt.id}: ${excerpt.item} has no licence`);
  Object.assign(excerpt, {
    file: file.name,
    title: file.title ?? metadata.metadata.title,
    creator: file.creator ?? metadata.metadata.creator,
    licence: itemCredit.licence,
    url: itemCredit.url,
  });
}

await writeFile(PATH, JSON.stringify(data, null, 2) + "\n");
console.log(`written ${PATH.pathname}`);
