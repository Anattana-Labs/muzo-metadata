/**
 * Cloudflare Worker: YouTube Music track metadata + matched JioSaavn stream
 *
 * ZERO-DEPENDENCY VERSION — no `npm install`, no imports at all.
 * JioSaavn matching/decryption is now delegated entirely to the
 * fast-saavn.vercel.app API (GET /?title=...&artist=...&duration=...),
 * which returns the media id/path as plain text. No DES decryption or
 * custom fuzzy-matching logic lives in this file anymore.
 *
 * Looks up the same track on two sources in parallel:
 *   - JioSaavn (via fast-saavn.vercel.app): matched by title/artist/
 *     duration, returns a media id/path that we turn into a stream URL.
 *   - Muzo (hf.space): matched directly by videoId (no fuzzy matching
 *     needed), giving an AAC stream + a lossless stream.
 *
 * Usage:
 *   GET /?videoId=YfqJktv2nuA
 *   GET /?videoId=YfqJktv2nuA&stream=0   (returns an error — nothing else is returned)
 *   GET /?videoId=YfqJktv2nuA&debug=1    (also returns the fast-saavn request URL/response)
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
const FAST_SAAVN_BASE_URL = "https://fast-saavn.vercel.app/";

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
        debug
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

// ---------- JioSaavn stream (via fast-saavn.vercel.app) ----------
//
// All title/artist/duration matching and encrypted_media_url decryption
// is delegated to fast-saavn.vercel.app. It takes title/artist/duration
// query params and returns the matched media id/path as plain text (e.g.
// "342/65e9f0a2e7c9f3e4e9b9f9a2e7c9f3e4"), which we turn into a full
// stream URL by appending "_<quality>.mp4" and prefixing the CDN host.

async function fetchSaavnStream(title, artistNames, ytDurationText, debug = false) {
  const primaryArtist = artistNames[0] || '';
  const durationSeconds = parseDurationToSeconds(ytDurationText);

  const params = new URLSearchParams();
  params.set('title', title);
  params.set('artist', primaryArtist);
  // fast-saavn accepts either "3:45" or a raw second count; prefer the
  // parsed second count when we have one, otherwise fall back to
  // whatever YT gave us verbatim.
  if (durationSeconds !== null) {
    params.set('duration', String(durationSeconds));
  } else if (ytDurationText) {
    params.set('duration', ytDurationText);
  }

  const apiUrl = `${FAST_SAAVN_BASE_URL}?${params.toString()}`;

  let response;
  try {
    response = await fetch(apiUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
  } catch (err) {
    return {
      matched: false,
      reason: "fast-saavn request failed",
      ...(debug ? { debug: { url: apiUrl, error: String(err) } } : {}),
    };
  }

  if (!response.ok) {
    return {
      matched: false,
      reason: `fast-saavn returned ${response.status}`,
      ...(debug ? { debug: { url: apiUrl, status: response.status } } : {}),
    };
  }

  const mediaPath = (await response.text()).trim();

  if (!mediaPath) {
    return {
      matched: false,
      reason: "No JioSaavn match from fast-saavn",
      ...(debug ? { debug: { url: apiUrl } } : {}),
    };
  }

  return {
    streamId: mediaPath,
    streamUrl: `https://aac.saavncdn.com/${mediaPath}_${SAAVN_QUALITY}.mp4`,
    ...(debug ? { debug: { url: apiUrl, mediaPath } } : {}),
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
