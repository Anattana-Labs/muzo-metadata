# YT Music Track Lookup Worker

A zero-dependency [Cloudflare Worker](https://workers.cloudflare.com/) that takes a YouTube Music `videoId` and returns:

- **Track metadata** from YouTube Music (title, artists, album, duration, thumbnails, explicit flag, song/music-video counterpart)
- **A matched JioSaavn stream** (AAC, up to 320 kbps), found by fuzzy matching and decrypted in pure JS
- **A Muzo stream** (AAC + lossless), matched directly by `videoId`
- **Artist avatars** at four sizes via the `/v1` endpoint, fetched from the YT Music artist page

Everything lives in a single file (`worker.js`) with no `npm install`, no imports and no `package.json`.

---

## Table of contents

- [Features](#features)
- [Endpoints](#endpoints)
- [Query parameters](#query-parameters)
- [Response shape](#response-shape)
- [Error responses](#error-responses)
- [How it works](#how-it-works)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Disclaimer](#disclaimer)

---

## Features

- **Single file, no dependencies.** Paste it into the Cloudflare dashboard's Quick Edit box or deploy with `wrangler`.
- **Parallel lookups.** JioSaavn, Muzo and (on `/v1`) artist avatar requests all run concurrently, and one failing never breaks the others.
- **Strict JioSaavn matching.** A candidate is only returned if title, duration, artist **and album** all match, so remixes, covers and reworks aren't served under the original's metadata.
- **Pure-JS DES-ECB decryption** for JioSaavn's `encrypted_media_url`. Workers' `node:crypto` polyfill doesn't support legacy DES, so it's implemented inline.
- **Song ↔ music video linking.** Reports whether the requested ID is the song (ATV) or official video (OMV) and finds the counterpart, with a search fallback for the music video.
- **Artist avatars at 4 sizes** (50, 150, 500, 544 px) from a single request per artist.
- **CORS enabled** (`Access-Control-Allow-Origin: *`) so it can be called straight from a browser.

---

## Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /?videoId=<id>` | Metadata + JioSaavn stream + Muzo stream |
| `GET /v1/?videoId=<id>` | Same as above, but each entry in `metadata.artists` also includes an `image` array (avatar at 4 qualities) |

`/v1` and `/v1/` are both accepted. The root endpoint makes no extra artist requests and behaves exactly as before.

### Examples

```bash
# Basic lookup
curl "https://<your-worker>.workers.dev/?videoId=YfqJktv2nuA"

# With artist avatars
curl "https://<your-worker>.workers.dev/v1/?videoId=YfqJktv2nuA"

# Include JioSaavn's raw search responses and match diagnostics
curl "https://<your-worker>.workers.dev/?videoId=YfqJktv2nuA&debug=1"
```

---

## Query parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `videoId` | Yes | The YouTube Music video ID |
| `debug=1` | No | Adds a `debug` object under `saavn` with the target, queries tried, raw JioSaavn responses, and per-candidate match results |
| `stream=0` | No | Returns a `400` error. Streams are the only thing this Worker returns, so disabling them leaves nothing to return |

---

## Response shape

### Root endpoint (`/`)

```json
{
  "metadata": {
    "videoId": "YfqJktv2nuA",
    "title": "Song Title",
    "artists": [
      { "name": "Artist Name", "browseId": "UCxxxxxxxx" }
    ],
    "album": { "name": "Album Name", "browseId": "MPREb_xxxxxxxx" },
    "duration": "3:42",
    "thumbnails": [{ "url": "...", "width": 60, "height": 60 }],
    "isExplicit": false,
    "isSongItem": true,
    "musicVideoId": "abc123xyz00",
    "musicVideo": {
      "videoId": "abc123xyz00",
      "title": "Song Title (Official Music Video)",
      "subtitle": "Video • Artist • 10M views",
      "thumbnails": []
    }
  },
  "saavn": {
    "streamId": "<saavn-media-id>",
    "streamUrl": "https://aac.saavncdn.com/<saavn-media-id>_320.mp4",
    "artists": {
      "primary":  [{ "id": "...", "name": "...", "role": "primary_artists", "type": "artist", "url": "..." }],
      "featured": [],
      "all":      []
    }
  },
  "muzo": {
    "aacStream": "https://...",
    "lossless": "https://..."
  }
}
```

Notes on `metadata`:

- `isSongItem` is `true` for a song (ATV), `false` for a music video (OMV), and `null` if YT Music didn't expose the type.
- A **song** gets `musicVideoId`. A **video** gets `songVideoId`. Never both.
- `musicVideo` only appears when the counterpart wasn't in the `/next` response and was found by the search fallback. It must contain the song title and the word "music".

### `/v1` endpoint

Identical, except each entry in `metadata.artists` is enriched with an `image` array:

```json
"artists": [
  {
    "name": "Artist Name",
    "browseId": "UCxxxxxxxx",
    "image": [
      { "quality": "50x50",   "width": 50,  "height": 50,  "url": "https://lh3.googleusercontent.com/...=w50-h50-p-l90-rj" },
      { "quality": "150x150", "width": 150, "height": 150, "url": "https://lh3.googleusercontent.com/...=w150-h150-p-l90-rj" },
      { "quality": "500x500", "width": 500, "height": 500, "url": "https://lh3.googleusercontent.com/...=w500-h500-p-l90-rj" },
      { "quality": "544x544", "width": 544, "height": 544, "url": "https://lh3.googleusercontent.com/...=w544-h544-p-l90-rj" }
    ]
  }
]
```

If an artist lookup fails, that artist is returned with `image: []` and the rest of the response is unaffected.

### When a source has no match

Each source degrades independently:

| Field | Value | Meaning |
| --- | --- | --- |
| `saavn` | `null` | The JioSaavn lookup threw an error |
| `saavn` | `{ "matched": false, "reason": "No JioSaavn search results" }` | JioSaavn returned nothing |
| `saavn` | `{ "matched": null, "reason": "..." }` | Results existed but none passed matching (for example, album mismatch) |
| `saavn` | `{ "streamId", "streamUrl", "artists" }` | Successful match |
| `muzo` | `null` | Muzo errored or has no stream for this ID |

Check for `saavn?.streamUrl` rather than just truthiness of `saavn`.

---

## Error responses

All errors are JSON: `{ "error": "..." }`.

| Status | Error | Cause |
| --- | --- | --- |
| `400` | `Missing videoId query param` | No `videoId` provided |
| `400` | `stream=0 disables the only thing this endpoint returns` | `stream=0` was passed |
| `404` | `Could not locate track metadata for this videoId` | The ID wasn't found in YT Music's `/next` response |
| `404` | `No stream match` | Metadata had no title or artists, or both JioSaavn and Muzo failed outright (threw or returned `null`) |
| `502` | `Upstream fetch failed` / `Upstream returned <status>` | YT Music request failed |

---

## How it works

```
GET /v1/?videoId=…
   │
   ├─► YT Music  /next  ─► track metadata, song/video type map
   │        └─► (fallback) /search Videos tab ─► music video ID
   │
   └─► in parallel (Promise.allSettled)
        ├─► JioSaavn: search → fuzzy match → DES-decrypt stream URL
        ├─► Muzo:     lookup by videoId
        └─► /v1 only: YT Music /browse per artist ─► avatar URLs
```

### JioSaavn matching

The Worker searches JioSaavn with `"<title> <primary artist>"` and, if that doesn't yield a strong match, widens to a title-only search and merges the results. A candidate must satisfy **all** of:

1. **Title:** JioSaavn's title starts with the YT title (after normalizing accents, `&`, and smart quotes).
2. **Duration:** within ±2 seconds of the YT duration.
3. **Artist:** matched at one of two tiers.
   - *Strong:* primary artist, featured artist, or `singer` role.
   - *Weak:* only via `music`/`lyricist` credits, which JioSaavn keeps on remixes and covers. This is used only as a last resort.
4. **Album:** JioSaavn's album name contains the YT album name. This is **required**, not a tiebreaker.

If a candidate passes 1–3 but fails on album, no stream is returned, with the reason `"Title/artist/duration matched a candidate, but its album didn't match — refusing to guess"`.

### Stream URL decryption

JioSaavn returns an `encrypted_media_url` (base64, DES-ECB, PKCS7-padded). The Worker decrypts it, strips the bitrate suffix, and rebuilds the URL at the quality set by `SAAVN_QUALITY`.

### Artist avatars

The `/browse` response for each artist includes a `googleusercontent` thumbnail URL whose size is controlled by a suffix (`=w544-h544-…`). The Worker takes the largest available thumbnail and rewrites that suffix for each of the four sizes, so it makes one request per artist rather than four. The `-p` flag enables smart cropping so wide banners still produce a square avatar.

---

## Deployment

### Option A: Cloudflare dashboard

1. Go to **Workers & Pages → Create → Create Worker**.
2. Click **Edit code** and replace the default script with the contents of `worker.js`.
3. Click **Deploy**.

### Option B: Wrangler

```bash
npm install -g wrangler
wrangler login
```

Create a `wrangler.toml` next to `worker.js`:

```toml
name = "ytm-track-lookup"
main = "worker.js"
compatibility_date = "2025-01-01"
```

Then deploy:

```bash
wrangler deploy
```

For local development:

```bash
wrangler dev
# → http://localhost:8787/v1/?videoId=YfqJktv2nuA
```

No `package.json` or `node_modules` are needed either way.

---

## Configuration

Constants at the top of `worker.js`:

| Constant | Default | Description |
| --- | --- | --- |
| `INNERTUBE_API_KEY` | (public web client key) | Key used for YT Music's internal Innertube API |
| `CLIENT_VERSION` | `1.20260825.00.00` | `WEB_REMIX` client version sent to YT Music. Bump it if requests start failing |
| `SAAVN_QUALITY` | `"320"` | JioSaavn stream bitrate: `"96"`, `"160"` or `"320"` |

Other tunables, in code:

- `YTM_ARTIST_IMAGE_QUALITIES` sets the avatar sizes returned on `/v1`.
- The duration tolerance (`<= 2` seconds) is in `evaluate()` inside `fetchSaavnStream`.

---

## Known limitations

- **Unofficial, undocumented APIs.** YT Music's Innertube API, JioSaavn's `api.php` and the Muzo api can all change or disappear without notice. YT Music in particular reshuffles its response nesting, which is why the code uses recursive `findAll` searches instead of fixed paths.
- **Artist avatar layout varies.** `/v1` looks for the thumbnail in the artist page header (`musicImmersiveHeaderRenderer`, `musicVisualHeaderRenderer`, `musicHeaderRenderer`, in that order). If an artist returns `image: []`, that artist's header structure may differ and the fallback chain in `fetchYtmArtist` needs adjusting.
- **One extra request per artist on `/v1`.** They run in parallel with the other lookups, but a track with many artists means many `/browse` calls.
- **JioSaavn coverage is a best guess.** Strict album matching means legitimate tracks with a different album name on JioSaavn (for example a single vs. a compilation) return no stream. Use `debug=1` to see why.
- **The DES implementation is bit-array based.** It's simple and dependency-free but not fast. That's fine for a single URL per request, but it isn't suited to bulk decryption.
- **No caching or rate limiting.** Each request hits every upstream service. Consider adding the Workers Cache API or a KV layer if you expect repeated lookups.
- **Lightly tested.** Verify the artist avatar output on a few tracks (single artist, multiple artists, non-Latin names) before relying on it.

---

## Disclaimer

This project talks to undocumented endpoints of third-party services and returns links to copyrighted audio. It's intended for personal and educational use. You're responsible for making sure your usage complies with the terms of service of YouTube Music, JioSaavn and Muzo, and with the copyright laws that apply to you.
