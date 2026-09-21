/**
 * Cloudflare Worker: YouTube Music track metadata + matched JioSaavn stream
 *
 * ZERO-DEPENDENCY VERSION — no `npm install`, no imports at all.
 * The DES-ECB decrypt needed for JioSaavn's encrypted_media_url is
 * implemented inline below in plain JS (single-file, ~120 lines),
 * so this can be pasted straight into the Cloudflare dashboard's
 * Quick Edit box, or deployed with `wrangler deploy` with no
 * package.json / node_modules required either way.
 *
 * Looks up the same track on two sources in parallel:
 *   - JioSaavn: matched by title/artist/duration/album (fuzzy), stream URL
 *     recovered by decrypting its encrypted_media_url. A candidate is only
 *     ever returned as a stream if its album also matches the YT Music
 *     album — title/artist/duration alone are not sufficient (see
 *     pickBest below).
 *   - Muzo (hf.space): matched directly by videoId (no fuzzy matching
 *     needed), giving an AAC stream + a lossless stream.
 *
 * Usage:
 *   GET /?videoId=YfqJktv2nuA
 *   GET /?videoId=YfqJktv2nuA&stream=0   (returns an error — nothing else is returned)
 *   GET /?videoId=YfqJktv2nuA&debug=1    (also returns JioSaavn's raw search response(s))
 *
 *   GET /v1/?videoId=YfqJktv2nuA
 *     Same response as the root endpoint, except each entry in
 *     metadata.artists also carries an `image` array — the artist's avatar
 *     (fetched via the YT Music artist page) at 50x50, 150x150, 500x500 and
 *     544x544, each with explicit width/height and url.
 */

const INNERTUBE_API_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const CLIENT_VERSION = "1.20260825.00.00";
const SAAVN_QUALITY = "320"; // 96 | 160 | 320

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const videoId = url.searchParams.get("videoId");
    const wantStream = url.searchParams.get("stream") !== "0";
    const debug = url.searchParams.get("debug") === "1";
    // /v1/ (or /v1) is the same lookup, but enriches metadata.artists
    // with avatar image links (from YT Music) at multiple qualities.
    const includeArtistImages = url.pathname === "/v1" || url.pathname === "/v1/";

    if (!videoId) {
      return jsonResponse({ error: "Missing videoId query param" }, 400);
    }

    let upstream;
    try {
      upstream = await fetch(
        `https://music.youtube.com/youtubei/v1/next?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": "https://music.youtube.com",
            "Referer": `https://music.youtube.com/watch?v=${videoId}`,
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          body: JSON.stringify(buildNextBody(videoId)),
        }
      );
    } catch (err) {
      return jsonResponse({ error: "Upstream fetch failed", detail: String(err) }, 502);
    }

    if (!upstream.ok) {
      return jsonResponse({ error: `Upstream returned ${upstream.status}` }, 502);
    }

    const data = await upstream.json();
    const allRenderers = findAll(data, "playlistPanelVideoRenderer");
    const currentIndex = allRenderers.findIndex((r) => r.videoId === videoId);

    if (currentIndex === -1) {
      return jsonResponse({ error: "Could not locate track metadata for this videoId" }, 404);
    }

    const current = allRenderers[currentIndex];
    const metadata = extractMetadata(current, videoId);

    const videoTypeMap = collectMusicVideoTypes(data);
    Object.assign(metadata, resolveSongVideoLinks(videoId, videoTypeMap));

    if (metadata.isSongItem === true && !metadata.musicVideoId && metadata.title) {
      try {
        const found = await searchYtmMusicVideo(metadata.title, metadata.artists?.[0]?.name);
        if (found) {
          metadata.musicVideoId = found.videoId;
          metadata.musicVideo = found;
        }
      } catch (err) {
        console.error("YTM video search failed:", err.message || err);
      }
    }

    if (!wantStream) {
      return jsonResponse({ error: "stream=0 disables the only thing this endpoint returns" }, 400);
    }
    if (!metadata.title || !metadata.artists?.length) {
      return jsonResponse({ error: "No stream match" }, 404);
    }

    const [saavnResult, muzoResult, artistsResult] = await Promise.allSettled([
      fetchSaavnStream(
        metadata.title,
        metadata.artists.map((a) => a.name),
        metadata.duration,
        metadata.album?.name,
        debug,
        false // artist avatars now come from YT Music (metadata.artists), not JioSaavn
      ),
      fetchMuzoStream(videoId),
      includeArtistImages ? fetchYtmArtists(metadata.artists) : Promise.resolve(null),
    ]);

    const saavn = saavnResult.status === "fulfilled" ? saavnResult.value : null;
    const muzo = muzoResult.status === "fulfilled" ? muzoResult.value : null;

    // /v1 only: swap in artists enriched with YTM avatar images
    if (includeArtistImages && artistsResult.status === "fulfilled" && artistsResult.value) {
      metadata.artists = artistsResult.value;
    }

    if (!saavn && !muzo) {
      return jsonResponse({ error: "No stream match" }, 404);
    }

    return jsonResponse({ metadata, saavn, muzo }, 200);
  },
};

// ---------- YT Music (next endpoint) ----------

function buildNextBody(videoId) {
  return {
    videoId,
    isAudioOnly: true,
    tunerSettingValue: "AUTOMIX_SETTING_NORMAL",
    watchEndpointMusicSupportedConfigs: {
      watchEndpointMusicConfig: {
        musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
      },
    },
    context: {
      client: {
        clientName: "WEB_REMIX",
        clientVersion: CLIENT_VERSION,
        hl: "en",
        gl: "US",
        platform: "DESKTOP",
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
  };
}

// Recursively collect every value found under `key` anywhere in the tree,
// in document order. Used instead of hardcoded paths since YT Music
// reshuffles nesting periodically.
function findAll(node, key, results = []) {
  if (!node || typeof node !== "object") return results;

  if (Array.isArray(node)) {
    for (const item of node) findAll(item, key, results);
    return results;
  }

  if (node[key]) results.push(node[key]);

  for (const k of Object.keys(node)) {
    if (k === key) continue;
    findAll(node[k], key, results);
  }

  return results;
}

// Walks the whole /next response looking for any object that carries both
// a videoId and a musicVideoType (these show up on watchEndpoint objects
// throughout the tree — e.g. the "Switch to music video" / "Switch to
// song" menu item, autoplay entries, etc). Builds a videoId -> type map
// covering every alternate version YT Music knows about for this track,
// where type is one of MUSIC_VIDEO_TYPE_ATV (song/official audio),
// MUSIC_VIDEO_TYPE_OMV (official music video), or MUSIC_VIDEO_TYPE_UGC
// (user-uploaded video).
function collectMusicVideoTypes(node, map = {}) {
  if (!node || typeof node !== "object") return map;

  if (Array.isArray(node)) {
    for (const item of node) collectMusicVideoTypes(item, map);
    return map;
  }

  const type =
    node.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType;
  if (node.videoId && type && !map[node.videoId]) {
    map[node.videoId] = type;
  }

  for (const key of Object.keys(node)) {
    collectMusicVideoTypes(node[key], map);
  }

  return map;
}

// Given the requested videoId and the videoId->musicVideoType map above,
// figures out whether the requested track is the song (ATV) or the
// official music video (OMV), and finds the id of its counterpart if YT
// Music exposed one. Only the counterpart field relevant to what was
// requested is included — a song gets `musicVideoId`, a video gets
// `songVideoId` — not both.
function resolveSongVideoLinks(videoId, videoTypeMap) {
  const currentType = videoTypeMap[videoId];
  const isSongItem = currentType ? currentType === "MUSIC_VIDEO_TYPE_ATV" : null;

  let musicVideoId = null;
  let songVideoId = null;

  for (const [id, type] of Object.entries(videoTypeMap)) {
    if (id === videoId) continue;
    if (type === "MUSIC_VIDEO_TYPE_OMV" && !musicVideoId) musicVideoId = id;
    if (type === "MUSIC_VIDEO_TYPE_ATV" && !songVideoId) songVideoId = id;
  }

  if (isSongItem === true) {
    return { isSongItem, musicVideoId };
  }
  if (isSongItem === false) {
    return { isSongItem, songVideoId };
  }
  return { isSongItem };
}

function extractRunsInfo(runs) {
  const artists = [];
  let album = null;

  for (const run of runs || []) {
    const browseId = run.navigationEndpoint?.browseEndpoint?.browseId;
    if (!browseId) continue;

    const pageType =
      run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType;

    if (pageType === "MUSIC_PAGE_TYPE_ARTIST" || browseId.startsWith("UC")) {
      artists.push({ name: run.text, browseId });
    } else if (pageType === "MUSIC_PAGE_TYPE_ALBUM" || browseId.startsWith("MPRE")) {
      album = { name: run.text, browseId };
    }
  }

  return { artists, album };
}

function extractMetadata(renderer, videoId) {
  const title = renderer.title?.runs?.[0]?.text;
  const runs = renderer.longBylineText?.runs || renderer.shortBylineText?.runs || [];
  const { artists, album } = extractRunsInfo(runs);

  const isExplicit = (renderer.badges || []).some(
    (b) => b.musicInlineBadgeRenderer?.icon?.iconType === "MUSIC_EXPLICIT_BADGE"
  );

  return {
    videoId,
    title,
    artists,
    album,
    duration: renderer.lengthText?.runs?.[0]?.text,
    thumbnails: renderer.thumbnail?.thumbnails,
    isExplicit,
  };
}

// ---------- Pure-JS DES-ECB (no dependencies) ----------
//
// Minimal, single-purpose DES implementation: decrypt-only, ECB mode,
// PKCS7-unpad. This is the classic DES algorithm (Feistel network,
// IP/FP + PC1/PC2 permutations, S-boxes) written directly against the
// standard tables — no external library, no node:crypto (whose Workers
// polyfill doesn't support legacy DES ciphers anyway).

const DES_PC1 = [
  57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,
  63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4,
];
const DES_PC2 = [
  14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,
  41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32,
];
const DES_SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const DES_IP = [
  58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,
  57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7,
];
const DES_FP = [
  40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,
  36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25,
];
const DES_E = [
  32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,
  16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1,
];
const DES_P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const DES_SBOX = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,
   4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,
   0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,
   13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,
   10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,
   4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,
   9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,
   1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,
   7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

function bytesToBits(bytes) {
  const bits = new Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
  }
  return bits;
}
function bitsToBytes(bits) {
  const bytes = new Array(bits.length / 8).fill(0);
  for (let i = 0; i < bits.length; i++) {
    bytes[i >> 3] |= bits[i] << (7 - (i & 7));
  }
  return bytes;
}
function permute(bits, table) {
  return table.map((pos) => bits[pos - 1]);
}
function leftShift(bits, n) {
  return bits.slice(n).concat(bits.slice(0, n));
}
function desSubKeys(keyBytes) {
  let keyBits = permute(bytesToBits(keyBytes), DES_PC1); // 56 bits
  let c = keyBits.slice(0, 28);
  let d = keyBits.slice(28);
  const subKeys = [];
  for (let round = 0; round < 16; round++) {
    c = leftShift(c, DES_SHIFTS[round]);
    d = leftShift(d, DES_SHIFTS[round]);
    subKeys.push(permute(c.concat(d), DES_PC2)); // 48 bits
  }
  return subKeys;
}
function feistel(rBits, subKey) {
  const expanded = permute(rBits, DES_E); // 48 bits
  const xored = expanded.map((b, i) => b ^ subKey[i]);
  let sboxOut = [];
  for (let s = 0; s < 8; s++) {
    const chunk = xored.slice(s * 6, s * 6 + 6);
    const row = (chunk[0] << 1) | chunk[5];
    const col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4];
    const val = DES_SBOX[s][row * 16 + col];
    sboxOut = sboxOut.concat([(val >> 3) & 1, (val >> 2) & 1, (val >> 1) & 1, val & 1]);
  }
  return permute(sboxOut, DES_P); // 32 bits
}
// Decrypt a single 8-byte block with a single 8-byte DES key.
function desDecryptBlock(blockBytes, keyBytes) {
  const subKeys = desSubKeys(keyBytes);
  let bits = permute(bytesToBits(blockBytes), DES_IP);
  let l = bits.slice(0, 32);
  let r = bits.slice(32);
  // Decryption uses subkeys in reverse order.
  for (let round = 15; round >= 0; round--) {
    const newL = r;
    const fOut = feistel(r, subKeys[round]);
    const newR = l.map((b, i) => b ^ fOut[i]);
    l = newL;
    r = newR;
  }
  return bitsToBytes(r.concat(l).concat([]).length ? permute(r.concat(l), DES_FP) : []);
}

const base64ToBytes = (b64) => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const decryptMediaUrl = (encryptedMediaUrl) => {
  if (!encryptedMediaUrl) return "";

  try {
    const keyBytes = [...new TextEncoder().encode('38346591')]; // 8-byte DES key
    const cipherBytes = base64ToBytes(encryptedMediaUrl);

    let out = [];
    for (let i = 0; i < cipherBytes.length; i += 8) {
      const block = [...cipherBytes.subarray(i, i + 8)];
      out = out.concat(desDecryptBlock(block, keyBytes));
    }

    // Strip PKCS7 padding from the end.
    const padLen = out[out.length - 1];
    if (padLen >= 1 && padLen <= 8) out = out.slice(0, out.length - padLen);

    const decoded = new TextDecoder().decode(new Uint8Array(out));
    return decoded.trim().replace('http:', 'https:');
  } catch (err) {
    console.error("Saavn decryptMediaUrl failed:", err.message || err);
    return "";
  }
};

// ---------- Artist avatar images (JioSaavn — legacy, no longer used by /v1) ----------
//
// /v1 now gets artist avatars from YT Music (see fetchYtmArtists below).
// These helpers are kept only because createArtistPayload still references
// them; they're inactive since fetchSaavnStream is called with
// includeArtistImages = false. Safe to delete along with the
// `includeImages` plumbing if you want the file tidier.
const ARTIST_IMAGE_QUALITIES = [
  { quality: "50x50", width: 50, height: 50 },
  { quality: "150x150", width: 150, height: 150 },
  { quality: "500x500", width: 500, height: 500 },
  { quality: "544x544", width: 544, height: 544 },
];

function getArtistImageLinks(imageUrl) {
  if (!imageUrl) return [];
  return ARTIST_IMAGE_QUALITIES.map(({ quality, width, height }) => ({
    quality,
    width,
    height,
    url: imageUrl.replace(/\d+x\d+/, quality),
  }));
}

const createArtistPayload = (artist, includeImages = false) => ({
  id: artist.id,
  name: artist.name,
  role: artist.role,
  type: artist.type,
  url: artist.perma_url,
  ...(includeImages ? { image: getArtistImageLinks(artist.image) } : {}),
});

const createSongPayload = (song, includeArtistImages = false) => {
  const info = song.more_info;
  return {
    id: song.id,
    name: song.title,
    duration: info?.duration ? Number(info.duration) : null,
    artists: {
      primary: info?.artistMap?.primary_artists?.map((a) => createArtistPayload(a, includeArtistImages)) || [],
      featured: info?.artistMap?.featured_artists?.map((a) => createArtistPayload(a, includeArtistImages)) || [],
      all: info?.artistMap?.artists?.map((a) => createArtistPayload(a, includeArtistImages)) || [],
    },
    downloadUrl: decryptMediaUrl(info?.encrypted_media_url),
  };
};

// Parses either "3:42" or "3:42.5..." style or a plain numeric string of
// seconds (YT's lengthText is always mm:ss / h:mm:ss).
const parseDurationToSeconds = (durationStr) => {
  if (!durationStr) return null;
  if (/^\d+$/.test(durationStr)) return Number(durationStr);

  const parts = durationStr.split(':').map(Number);
  if (parts.some(isNaN)) return null;

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  } else if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
};

const normalizeString = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const clean = (str) =>
  normalizeString(str).toLowerCase().replace(/&amp;/g, ' ').replace(/&/g, ' ').replace(/\s+/g, ' ').trim();

// Strip smart quotes / curly quotes down to plain ASCII quotes so titles
// like `Boom Boom (From "Dude (Telugu)")` compare consistently regardless
// of which quote characters YT vs Saavn happen to use.
const straightenQuotes = (str) =>
  str.replace(/[\u2018\u2019\u2032]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"');

const cleanForCompare = (str) => clean(straightenQuotes(str));

async function searchJioSaavn(query) {
  // JioSaavn's search.getResults pages start at 1, not 0 — p=0 silently
  // returns a shifted/invalid window that can drop the actual top hit
  // (which is exactly what was happening: the correct original track never
  // showed up in results at all, at any tier, because it was paginated out
  // before our matching logic ever saw it).
  //
  // Param order/set matches the exact request JioSaavn's own web client
  // sends (p, q, _format, _marker, api_version, ctx, n, __call).
  const params = new URLSearchParams();
  params.set('p', '1');
  params.set('q', query);
  params.set('_format', 'json');
  params.set('_marker', '0');
  params.set('api_version', '4');
  params.set('ctx', 'web6dot0');
  params.set('n', '20');
  params.set('__call', 'search.getResults');
  const jioSaavnApiUrl = `https://www.jiosaavn.com/api.php?${params.toString()}`;

  const response = await fetch(jioSaavnApiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
      'Referer': 'https://www.jiosaavn.com/',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`JioSaavn API returned ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return { url: jioSaavnApiUrl, results: data.results || [], raw: data };
}

async function fetchSaavnStream(title, artistNames, ytDurationText, albumName, debug = false, includeArtistImages = false) {
  const primaryArtist = artistNames[0] || '';
  const cleanedTitle = title.replace(/\(.*?\)/g, '').trim();

  const targetDurationSeconds = parseDurationToSeconds(ytDurationText);
  const normalizedYtArtists = artistNames
    .map((n) => normalizeString(n).toLowerCase())
    .filter((n) => n.length > 0); // drop blanks so they can't false-match via startsWith('')

  const matchName = (normSaavn, ytName) =>
    normSaavn.startsWith(ytName) || ytName.startsWith(normSaavn);
  const anyMatch = (saavnNames, ytNames) =>
    saavnNames.length > 0 && ytNames.length > 0 && saavnNames.some((s) => ytNames.some((y) => matchName(s, y)));

  const evaluate = (track) => {
    const primaryArtists = track.artists?.primary?.map((a) => a.name.trim()) || [];
    const featuredArtists = track.artists?.featured?.map((a) => a.name.trim()) || [];
    const singers = track.artists?.all?.filter((a) => a.role === 'singer').map((a) => a.name.trim()) || [];
    const writerCredits = track.artists?.all
      ?.filter((a) => a.role === 'music' || a.role === 'lyricist')
      .map((a) => a.name.trim()) || [];

    const normalize = (arr) =>
      [...new Set(arr)].map((n) => normalizeString(n).toLowerCase()).filter((n) => n.length > 0);

    // Two tiers, since JioSaavn keeps the ORIGINAL songwriter's "music"/"lyricist"
    // credit on remixes, covers, and reworks even when a completely different
    // artist performs them (a "(Remix)" by Artist B still lists Artist A as
    // composer). A match on writer credits alone isn't reliable evidence this
    // is the same recording — but on some legitimately-tagged tracks it's the
    // ONLY credit JioSaavn has, so it's still useful as a last resort.
    //   strong = matches via primary/featured artist or the actual "singer" role
    //   weak   = matches only via the composer/writer ("music"/"lyricist") role
    const strongPool = normalize([...primaryArtists, ...featuredArtists, ...singers]);
    const weakPool = normalize(writerCredits);

    const strongArtistMatch = anyMatch(strongPool, normalizedYtArtists);
    const weakArtistMatch = !strongArtistMatch && anyMatch(weakPool, normalizedYtArtists);

    const titleMatches = cleanForCompare(track.name).startsWith(cleanForCompare(title));

    // Album match. Now REQUIRED (not just a tiebreaker) — a remix/cover/
    // rework is almost always released under a different album than the
    // original, even when title, duration, and (via a writer credit) an
    // artist name all happen to line up. If we can't confirm the album,
    // we don't return a stream for that candidate at all (see pickBest).
    const albumMatches =
      !!albumName &&
      !!track.albumName &&
      cleanForCompare(track.albumName).includes(cleanForCompare(albumName));

    let durationDiff = null;
    let durationMatches = true;
    if (targetDurationSeconds !== null && track.duration !== null) {
      durationDiff = Math.abs(track.duration - targetDurationSeconds);
      durationMatches = durationDiff <= 2;
    } else if (targetDurationSeconds !== null) {
      durationMatches = false;
    }

    return { titleMatches, strongArtistMatch, weakArtistMatch, albumMatches, durationMatches, durationDiff };
  };

  // Pick the best candidate out of a pool: title + duration + artist
  // (strong tier preferred over weak tier) are necessary but no longer
  // sufficient — the album must also match, or we return no track at all
  // rather than risk serving a remix/cover/rework's stream under the
  // original's metadata.
  const pickBest = (pool) => {
    const passesBase = (track) => {
      const r = evaluate(track);
      return r.titleMatches && r.durationMatches;
    };
    const strongCandidates = pool.filter((t) => passesBase(t) && evaluate(t).strongArtistMatch);
    const strongAlbumMatch = strongCandidates.find((t) => evaluate(t).albumMatches);
    if (strongAlbumMatch) {
      return { track: strongAlbumMatch, tier: "strong" };
    }

    const weakCandidates = pool.filter((t) => passesBase(t) && evaluate(t).weakArtistMatch);
    const weakAlbumMatch = weakCandidates.find((t) => evaluate(t).albumMatches);
    if (weakAlbumMatch) {
      return { track: weakAlbumMatch, tier: "weak" };
    }

    // Title/duration/artist matched something, but none of those
    // candidates also matched on album — refuse to guess.
    const hadArtistMatchWithoutAlbum = strongCandidates.length > 0 || weakCandidates.length > 0;
    return { track: null, tier: null, albumBlocked: hadArtistMatchWithoutAlbum };
  };

  // Query attempts, from narrowest to widest. The narrow query (title +
  // primary artist) is usually enough, but JioSaavn's own search relevance
  // can sometimes fail to surface the original at all for a given query
  // string — so if the narrow query doesn't produce a strong match, widen
  // with a title-only search and merge the pools before giving up.
  const queries = [
    `${cleanedTitle} ${primaryArtist}`.trim(),
    cleanedTitle,
  ];

  const seenIds = new Set();
  const pool = [];
  const queriesTried = [];
  const rawResponses = []; // always collected; only returned to the caller when debug=true
  let best = { track: null, tier: null, albumBlocked: false };

  for (const query of queries) {
    let searchResult;
    try {
      searchResult = await searchJioSaavn(query);
    } catch (err) {
      searchResult = { url: null, results: [], raw: { error: String(err) } };
    }
    queriesTried.push(searchResult.url || query);
    rawResponses.push({ query, url: searchResult.url, raw: searchResult.raw });

    for (const song of searchResult.results) {
      if (seenIds.has(song.id)) continue;
      seenIds.add(song.id);
      const processed = createSongPayload(song, includeArtistImages);
      processed.albumName = song.more_info?.album || null;
      pool.push(processed);
    }

    best = pickBest(pool);
    if (best.tier === "strong") break; // good enough — stop widening
  }

  if (pool.length === 0) {
    return {
      matched: false,
      reason: "No JioSaavn search results",
      ...(debug
        ? { debug: { target: { title, artistNames, targetDurationSeconds, albumName }, queriesTried, rawResponses } }
        : {}),
    };
  }

  const matchingTrack = best.track;
  const matchTier = best.tier;
  const reason = !matchingTrack
    ? (best.albumBlocked
        ? "Title/artist/duration matched a candidate, but its album didn't match — refusing to guess"
        : "No candidate matched on title, duration, and artist")
    : undefined;

  const debugInfo = debug
    ? {
        target: { title, artistNames, targetDurationSeconds, albumName },
        queriesTried,
        rawResponses,
        chosenId: matchingTrack ? matchingTrack.id : null,
        matchTier,
        reason,
        candidates: pool.map((t) => {
          const r = evaluate(t);
          return {
            id: t.id,
            name: t.name,
            album: t.albumName,
            duration: t.duration,
            titleMatches: r.titleMatches,
            strongArtistMatch: r.strongArtistMatch,
            weakArtistMatch: r.weakArtistMatch,
            albumMatches: r.albumMatches,
            durationMatches: r.durationMatches,
            durationDiff: r.durationDiff,
          };
        }),
      }
    : undefined;

  if (!matchingTrack || !matchingTrack.downloadUrl) {
    return debug ? { matched: null, reason, debug: debugInfo } : { matched: null, reason };
  }

  // The decrypted URL looks like https://aac.saavncdn.com/<id>_<bitrate>.mp4
  // Strip the bitrate suffix so we can pick our own quality.
  const trimmedId = matchingTrack.downloadUrl.replace(
    /^https:\/\/aac\.saavncdn\.com\/(.*?)_\d+\.mp4$/,
    '$1'
  );

  return {
    streamId: trimmedId,
    streamUrl: `https://aac.saavncdn.com/${trimmedId}_${SAAVN_QUALITY}.mp4`,
    artists: matchingTrack.artists,
    ...(debug ? { debug: debugInfo } : {}),
  };
}

// ---------- Muzo (hf.space) ----------
//
// Unlike JioSaavn, this is matched directly by videoId — no title/artist/
// duration fuzzy matching needed since the lookup is exact.

async function fetchMuzoStream(videoId) {
  const response = await fetch(
    `https://shashwatidr-casquad.hf.space/api/stream?id=${encodeURIComponent(videoId)}`
  );

  if (!response.ok) {
    throw new Error(`Muzo API returned ${response.status}`);
  }

  const data = await response.json();
  if (!data || (!data.url && !data.lossless)) {
    return null;
  }

  return {
    aacStream: data.url,
    lossless: data.lossless,
  };
}

// ---------- Artist details + avatar (YT Music browse endpoint) ----------
//
// For /v1: each artist in metadata.artists (which already has name +
// browseId from the /next response) is looked up via YT Music's `browse`
// endpoint. The header's thumbnail URL is a googleusercontent URL ending in
// a size suffix like "=w544-h544-l90-rj"; swapping the w/h values returns
// the same image at another size, so one request gives all qualities.

const YTM_ARTIST_IMAGE_QUALITIES = [
  { quality: "50x50", width: 50, height: 50 },
  { quality: "150x150", width: 150, height: 150 },
  { quality: "500x500", width: 500, height: 500 },
  { quality: "544x544", width: 544, height: 544 },
];

function resizeYtmImage(url, width, height) {
  if (!url) return null;
  const base = url.split("=")[0]; // strip existing size suffix
  // -p = smart crop, so wide banners still give a proper square avatar
  return `${base}=w${width}-h${height}-p-l90-rj`;
}

function buildArtistImageLinks(thumbnails) {
  if (!thumbnails?.length) return [];
  // pick the largest available source thumbnail as the base
  const best = thumbnails.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
  return YTM_ARTIST_IMAGE_QUALITIES.map(({ quality, width, height }) => ({
    quality,
    width,
    height,
    url: resizeYtmImage(best.url, width, height),
  }));
}

async function fetchYtmArtist(artist) {
  const response = await fetch(
    `https://music.youtube.com/youtubei/v1/browse?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://music.youtube.com",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        browseId: artist.browseId,
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: CLIENT_VERSION,
            hl: "en",
            gl: "US",
            platform: "DESKTOP",
          },
        },
      }),
    }
  );

  if (!response.ok) throw new Error(`YTM browse returned ${response.status}`);

  const data = await response.json();
  const header =
    data.header?.musicImmersiveHeaderRenderer ||
    data.header?.musicVisualHeaderRenderer ||
    data.header?.musicHeaderRenderer ||
    data.header ||
    {};

  // Prefer the foreground (avatar) thumbnail, fall back to the main one.
  const thumbnails =
    findAll(header.foregroundThumbnail, "thumbnails")[0] ||
    findAll(header.thumbnail, "thumbnails")[0] ||
    findAll(header, "thumbnails")[0] ||
    [];

  return {
    name: header.title?.runs?.[0]?.text || artist.name,
    browseId: artist.browseId,
    image: buildArtistImageLinks(thumbnails),
  };
}

async function fetchYtmArtists(artists) {
  const results = await Promise.allSettled(artists.map((a) => fetchYtmArtist(a)));
  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.error("YTM artist fetch failed:", r.reason?.message || r.reason);
    return { name: artists[i].name, browseId: artists[i].browseId, image: [] };
  });
}

// Fallback for when the /next response doesn't expose a "Switch to music
// video" watchEndpoint for this song (happens often — YT Music doesn't
// always surface it). Runs a normal YT Music search filtered to the
// Videos tab, and picks the first result whose title contains both the
// song's name and the word "music" (catches "... (Official Music
// Video)", "... - Music Video", etc., while skipping lyric videos,
// covers, or unrelated uploads that just happen to share a name).
//
// The `params` value below is YT Music's internal filter token for the
// "Videos" search tab — a fixed, publicly-known value (used by open
// source YTM clients), not something derived per-request.
const YTM_VIDEO_FILTER_PARAMS = "EgWKAQIQAWoMEAMQBBAJEAoQBRAQ";

async function searchYtmMusicVideo(songTitle, primaryArtistName) {
  const query = primaryArtistName ? `${songTitle} ${primaryArtistName}` : songTitle;

  const response = await fetch(
    `https://music.youtube.com/youtubei/v1/search?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://music.youtube.com",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        query,
        params: YTM_VIDEO_FILTER_PARAMS,
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: CLIENT_VERSION,
            hl: "en",
            gl: "US",
            platform: "DESKTOP",
          },
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`YTM search returned ${response.status}`);
  }

  const data = await response.json();
  const items = findAll(data, "musicResponsiveListItemRenderer");

  const cleanTitle = cleanForCompare(songTitle.replace(/\(.*?\)/g, ""));

  for (const item of items) {
    const flexColumns = item.flexColumns || [];
    const titleText =
      flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
        ?.map((r) => r.text)
        .join("") || "";
    if (!titleText) continue;

    const titleLower = titleText.toLowerCase();
    const titleMatches = cleanForCompare(titleText).includes(cleanTitle);
    const mentionsMusic = titleLower.includes("music");
    if (!titleMatches || !mentionsMusic) continue;

    const videoIdFound =
      item.playlistItemData?.videoId ||
      item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
        ?.playNavigationEndpoint?.watchEndpoint?.videoId;
    if (!videoIdFound) continue;

    const subtitleRuns =
      flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const subtitle = subtitleRuns.map((r) => r.text).join("");

    const thumbnails =
      item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || null;

    return {
      videoId: videoIdFound,
      title: titleText,
      subtitle: subtitle || null,
      thumbnails,
    };
  }

  return null;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
