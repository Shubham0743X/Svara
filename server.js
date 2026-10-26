const express = require('express');
const { Innertube, Parser, YTNodes } = require('youtubei.js');
const { Readable } = require('stream');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');

const execFileP = promisify(execFile);
// Looks for yt-dlp.exe in this same folder (rename to 'yt-dlp' on Mac/Linux)
const YTDLP = process.env.YTDLP || path.join(__dirname, 'yt-dlp.exe');

const app = express();
let yt;
async function getYt(){ if (!yt) yt = await Innertube.create(); return yt; }

/* ================= Wave 4AK — response caching (headers only) =================
   Measured live against this server, warm process, identical params, hit 1 -> hit 2:
     suggest 506->164ms · search 690->714ms · radio 1085->1708ms · lyrics 459->490ms ·
     artist 660->468ms · artist/songs 1401->1348ms · album 309->281ms · thumb 727->262ms
   Every one of those calls hits youtubei.js again: nothing but /api/thumb sent a Cache-Control
   header. This wave adds ONLY that header. No server-side response store, no JS/IndexedDB/
   localStorage layer, no body, no status code and no route signature changes.

   /api/search is DELIBERATELY NEVER CACHED, and that is a measured decision, not caution. Its
   pagination handle reaches the client INSIDE the body — `{ items, sessionId, next:true }` — and
   `sessionId` is a key into the in-memory `searchSessions` Map. A replayed body after a restart
   therefore advertises `next:true` with a handle that can never be resumed: /api/search/next
   answers `{ items:[], next:false, error:'session expired' }` (verified live with a stale id), the
   client ends paging and prints "End of results" — page 2+ is silently lost. Freezing that body
   in a browser cache (or letting its Express ETag answer a 304) would ship exactly that bug, so
   this route is sent `no-store` until the handle is provable across a restart.

   Failures are NEVER cached: a non-200, a body carrying `error`, or an empty result is sent with
   `no-store`, so 4AF's "Search failed" state can never become sticky. */
const CACHE_TTL = {
  /* WAVE 34b — NOT a day any more. The payload depends on the requested `duration` (it steers the
     LRClib row pick) and on the normaliser in THIS file, so a 24h browser copy outlived both: a
     file fetched before the audio length was known kept the weaker row, and a shape fix shipped
     in an update stayed invisible for a day (measured: the old range-form line survived a reload).
     The client keeps its own in-memory cache for the session, so this costs at most one refetch
     per track and provider. */
  '/api/lyrics': 0,           // never: duration-dependent, and the parser can change with a build
  '/api/album': 1800,
  '/api/artist': 1800,
  '/api/artist/songs': 1800,
  '/api/suggest': 600,
  '/api/radio': 600
};
/* A body may be cached only when it is a successful, non-empty payload. `error` is a plain string
   on every route that has one ('' when there is none), so truthiness is the test. */
function cacheableBody(body){
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.error) return false;                                     // explicit failure
  if ('id' in body && body.id === null) return false;               // artist not found
  if (Array.isArray(body.items) && !body.items.length) return false;
  if (Array.isArray(body.tracks) && !body.tracks.length) return false;
  if (Array.isArray(body.songs) && !body.songs.length) return false;
  if ('plain' in body && !body.plain && !body.synced) return false; // lyrics: nothing found
  return true;
}
/* Wrap res.json for ONE request so every response of that route decides its own header — no call
   site inside the handler has to be rewritten. res.setHeader before the body is written is always
   legal (res.json has not sent headers yet). */
function cacheHeaders(res, route){
  const ttl = CACHE_TTL[route] || 0;
  const json = res.json.bind(res);
  res.json = function(body){
    try {
      if (ttl && res.statusCode === 200 && cacheableBody(body)) res.setHeader('Cache-Control', 'private, max-age=' + ttl);
      else res.setHeader('Cache-Control', 'no-store');
    } catch (e) {}
    return json(body);
  };
}
/* Routes that must never be cached claim it up front, so the header is set whatever the handler
   ends up doing (stream pipe, file download, error JSON, or a 206). */
function noStore(res){
  try { res.setHeader('Cache-Control', 'no-store') } catch (e) {}
  const json = res.json.bind(res);
  res.json = function(body){ try { res.setHeader('Cache-Control', 'no-store') } catch (e) {} return json(body); };
}

/* ================= helpers ================= */
/* Outbound requests get a deadline. These routes answer a request the renderer is waiting on,
   so a hung upstream connection must fail (and let the caller's own retry run) instead of
   holding the response open indefinitely. */
function fetchT(url, opts, ms){
  return fetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(ms || 12000) }));
}
/* Same, for a request whose BODY is streamed to the client (artwork, audio): the deadline covers
   the handshake only. Aborting after the headers would cut a song off mid-playback. */
async function fetchHead(url, opts, ms){
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms || 12000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); }
  finally { clearTimeout(timer); }
}
function txt(v, seen = new WeakSet()) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v !== 'object') return '';
  if (seen.has(v)) return '';
  seen.add(v);
  if (Array.isArray(v)) return v.map(x => txt(x, seen)).join(' ').replace(/\s+/g, ' ').trim();
  if (v.text != null) return txt(v.text, seen);
  if (v.simpleText != null) return txt(v.simpleText, seen);
  if (Array.isArray(v.runs)) return v.runs.map(x => txt(x, seen)).join('');
  if (Array.isArray(v.contents)) return v.contents.map(x => txt(x, seen)).join(' ').replace(/\s+/g, ' ').trim();
  return '';
}
function bestUrl(th){
  const arr = Array.isArray(th) ? th : [];
  if (!arr.length) return '';
  let best = arr[0];
  for (const t of arr) if ((t.width || 0) > (best.width || 0)) best = t;
  let url = best.url || '';
  const m = url.match(/=w\d+-h\d+[^"?]*$/);
  if (m) url = url.slice(0, m.index) + '=w544-h544-l90-rj';
  return url;
}
function collectItems(node, out){
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)){ node.forEach(n => collectItems(n, out)); return out; }
  if (node.type === 'MusicResponsiveListItem' || node.type === 'MusicTwoRowItem') out.push(node);
  if (Array.isArray(node.contents)) node.contents.forEach(n => collectItems(n, out));
  return out;
}
function extractArtist(item){
  // metadata first: artists[] (song rows) → authors[] (video rows) → author (album rows).
  // Subtitle parsing below is only the last resort — it can pick up a year or a
  // play count on rows that carry no credits, and a flat artist string must never
  // take its value from a title.
  const src = Array.isArray(item.artists) && item.artists.length ? item.artists
    : Array.isArray(item.authors) && item.authors.length ? item.authors
    : item.author ? [item.author] : [];
  const names = src.map(a => typeof a === 'string' ? a : txt(a && (a.name != null ? a.name : a.text))).filter(Boolean);
  if (names.length) return names.join(', ');
  const flex = flexCredits(item);                 // rows that ship credits only in flex[1]
  if (flex) return flex;
  const sub = txt(item.subtitle);
  const parts = sub.split('•');
  if (parts.length > 1) return parts.slice(1).join('•').trim();
  return '';
}
/* 4AP: a TITLE-ONLY "credit" — the resolved artist string is just the track's own title. This is
   what a producer writes when NO structured credit exists and it falls back to a text field that
   happens to hold the title. The measured case is the up-next panel: PlaylistPanelVideo carries
   short_byline/long_byline/subtitle/author ALL empty, `album.name` equal to the title on singles
   (verified live: title "Self Aware", album "Self Aware", artists [Temper City]) and byline()
   fell through to that album name. Such a string is not an identity — it must never be shown,
   dialled as an artist, stored in history, or fed to lyrics matching. */
function normCredit(s){
  return String(s == null ? '' : s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function isTitleOnlyCredit(artist, title){
  const a = normCredit(artist), t = normCredit(title);
  return !!a && a === t;
}
// was there ANY structured credit on the row? (this is the gate: a real credit is never touched)
function hasStructuredCredit(i){
  return (Array.isArray(i.artists) && i.artists.length) ||
         (Array.isArray(i.authors) && i.authors.length) ||
         !!i.author;
}
// artist objects WITH channel ids, alongside the flat `artist` string (never replaces it).
// youtubei.js 18 shapes: song rows -> `artists[]`, video rows -> `authors[]`,
// album/playlist rows -> a single `author`. Each entry: { name, channel_id }.
// Some rows carry NO structured credits at all (artists/authors/author/subtitle all empty)
// yet still show "Artist • Album • 2:10" in flex_columns[1] — verified on live search rows.
// The artist is the first remaining segment; a duration, a release date or a play count must
// never be promoted into the artist field.
// 4W-D2: every flex line measured on 18.0.0 BEGINS with the row's own type label ("Song • The
// Weeknd", "Episode • 12h ago • The 44Two Live Podcast", "Artist • 664M monthly audience"), and
// in type=all many song rows publish NO structured credits at all, so this line is the only
// credit source left. Measured live ("weekend" / type=all, 18.0.0): "Starboy (feat. Daft Punk)",
// "Blinding Lights" and "Reminder" have artists/authors/author EMPTY and a flex line of exactly
// "Song • 3:51" — YouTube publishes no artist for them at all. flexCredits() used to hand that
// leading label back as the artist, which is why those rows read "Song • 3:51" and why the
// label showed up as a dead artist link.
const ROW_LABELS = ['song', 'video', 'album', 'single', 'ep', 'playlist', 'podcast', 'episode', 'artist', 'profile'];
function isRowLabel(s){ return ROW_LABELS.indexOf(String(s == null ? '' : s).toLowerCase()) >= 0 }
function flexSegments(item){
  try {
    const runs = ((((item.flex_columns || [])[1] || {}).title) || {}).runs || [];
    const line = runs.map(r => txt(r.text)).join('').replace(/\s+/g, ' ').trim();
    return line ? line.split('•').map(s => s.trim()).filter(Boolean) : [];
  } catch (e) { return []; }
}
// A flex segment that measured as anything BUT an artist: a duration (3:51 / 1:00:52), an album
// year (2026), a release date (Jan 22, 2020 / Sep 11), a relative date (12h ago), a play count
// (1.4B views), a playlist length (54 songs), a subscriber/audience figure (1.66K subscribers /
// 664M monthly audience) or a handle (@weekendvibes143). Verified against every segment in the
// type=all rows of "weekend" and "arijit singh" — real names (incl. "3 Steps Ahead", "Caitlin.M💐",
// "সা") are untouched.
const NOT_ARTIST = /^(\d{1,2}:\d{2}(:\d{2})?|\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(,? \d{4})?|\d+\s*(h|d|w|mo|y)\s+ago|[\d.,]+\s*[KMB]?\s*views?|\d+\s*songs?|[\d.,]+\s*[KMB]?\s*subscribers?|[\d.,]+\s*[KMB]?\s*monthly audience|@[^\s]+)$/i;
function flexCredits(item){
  const seg = flexSegments(item).filter(s => !isRowLabel(s) && !NOT_ARTIST.test(s));
  return seg[0] || '';
}
// the row's own type label, straight off the flex line ("Song", "Episode", …) — '' when absent
function flexLabel(item){
  const seg = flexSegments(item);
  return seg.length && isRowLabel(seg[0]) ? seg[0] : '';
}
// the label the All list prints in front of a row ("Song • <artist> • 3:51"): the flex line's own
// label, else the parsed item_type. Only unfiltered results are given it — see /api/search.
function rowLabel(item){
  const f = flexLabel(item);
  if (f) return f;
  const t = (item && item.item_type) || '';
  if (t === 'song' || t === 'non_music_track') return 'Song';
  if (t === 'video') return 'Video';
  if (t === 'album') return 'Album';
  if (t === 'artist') return 'Artist';
  return '';
}
function artistList(item){
  try {
    const src = Array.isArray(item.artists) && item.artists.length ? item.artists
      : Array.isArray(item.authors) && item.authors.length ? item.authors
      : item.author ? [item.author] : [];
    return src.map(a => {
      if (typeof a === 'string') return { name: a, id: null };
      return {
        name: txt(a && (a.name != null ? a.name : a.text)) || '',
        id: (a && (a.channel_id || a.browse_id || a.id)) || null
      };
    }).filter(a => a.name || a.id);
  } catch (e) { return []; }
}
// 4W: `kind` now comes from the row's REAL `item_type`, so a mixed result set is never
// mislabelled as a playable track. type=all is genuinely unfiltered and returns songs,
// albums, artists, playlists, podcasts and non-music tracks in one list (measured live on
// 18.0.0, "Arijit Singh": song 7 · album 4 · playlist 6 · artist 6 · video 3 ·
// non_music_track 3 · podcast_show 3 = 32 rows).
//   song | video                                    -> 'track'  (playable)
//   album                                           -> 'album'  (client opens the album page)
//   artist                                          -> 'artist' (client opens the artist page)
//   playlist | podcast_show | non_music_track | etc  -> 'other'  (client renders it inert)
// VERIFIED: artist rows ship an EMPTY `title` — item_type 'artist', `name` = 'Arijit Singh',
// `title` = ''. The name is on `name` (a plain string), with flex_columns[0] as fallback,
// and `id` is the channel id. Without this branch artist rows render with a blank title.
function rowKind(i, isAlbum){
  const t = (i && i.item_type) || '';
  const id = String((i && i.id) || '');
  if (t === 'artist') return 'artist';        // channel id: UC… (24)
  if (t === 'album') return 'album';          // album id: MPREb_… (17)
  // 4W-D3: an EPISODE row hides behind item_type 'non_music_track' AND an 11-char video id, so the
  // id-shape rule below lets it through as a playable track. Measured live ("weekend" / type=all,
  // 18.0.0): title "Wild Wild Weekend! | 4-4-Two | S6 E6", item_type 'non_music_track', id
  // bqo6gm3U4Uk, flex "Episode • 12h ago • The 44Two Live Podcast" — rendered as an "Episode" row
  // Svara can neither play nor open. Its own row label says Episode/Podcast, so drop it by label.
  // The genuine `non_music_track` SONGS 4W proved playable (Shayad MJyKN-8UncM, Khairiyat
  // hoNb6HuNmU0, measured live on 18.0.0 in type=video) carry NO label on the flex line — their
  // first segment is a release date ("Jan 22, 2020" / "Sep 26, 2019") — so this never touches them.
  const lab = flexLabel(i).toLowerCase();
  if (lab === 'episode' || lab === 'podcast') return 'other';
  // A PLAYABLE row is decided by ID SHAPE, not by item_type alone. Measured live: inside
  // type=video YouTube labels three genuine songs `non_music_track` ('Shayad', 'Kalank (Duet)',
  // 'Khairiyat (Bonus Track)') and still gives them 11-char video ids (MJyKN-8UncM / Grr0FlC8SQA /
  // hoNb6HuNmU0) — they are perfectly playable, so they must NOT be buried as 'other'.
  // Every playable row measured (song / video / non_music_track) had an 11-char id; albums
  // (MPREb_…, 17), channels (UC…, 24), playlists (VL…/VLPL…/VLRDCLAK5uy_…, 36–45) and podcast
  // shows (MPSP…, 17–38) never did. The same 11-char shape the client already uses for ytimg art.
  if (/^[A-Za-z0-9_-]{11}$/.test(id)) return isAlbum ? 'album' : 'track';
  if (t === 'song' || t === 'video') return isAlbum ? 'album' : 'track';
  return 'other';
}
function mapTrack(i, fallbackThumb, isAlbum, withLabel){
  try {
    const th = i.thumbnail?.contents || [];
    const kind = rowKind(i, isAlbum);
    const isArtistRow = kind === 'artist';
    const artName = isArtistRow ? (txt(i.name) || flexText(i, 0)) : '';
    const title = isArtistRow ? (artName || txt(i.title)) : txt(i.title);
    let artist = isArtistRow ? artName : extractArtist(i);
    let artists = isArtistRow ? (i.id ? [{ name: artName, id: i.id }] : []) : artistList(i);
    /* 4AP: no structured credit AND the resolved string equals the title -> drop the poison
       (artist:'', artists:[]). A row carrying real artists[]/authors[]/author credits is NEVER
       touched, and artist rows keep their name. */
    if (!isArtistRow && !hasStructuredCredit(i) && isTitleOnlyCredit(artist, title)){
      artist = '';
      artists = [];
    }
    return {
      id: i.id,
      kind,
      label: withLabel ? rowLabel(i) : '',   // 4W-D2: the All list's own per-row type label
      title,
      artist,
      artists,
      sub: txt(i.subtitle) || txt(i.album) || '',
      thumb: bestUrl(th) || fallbackThumb || '',
      duration: i.duration?.text ? String(i.duration.text) : ''
    };
  } catch (e) { return null; }
}
// find the song shelf inside a search result — it owns the "load more" continuation
function findMusicShelf(node, depth){
  if (!node || typeof node !== 'object' || (depth || 0) > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node){ const hit = findMusicShelf(n, (depth || 0) + 1); if (hit) return hit; }
    return null;
  }
  if (node.type === 'MusicShelf' && Array.isArray(node.contents)) return node;
  if (Array.isArray(node.contents)) {
    for (const n of node.contents){ const hit = findMusicShelf(n, (depth || 0) + 1); if (hit) return hit; }
  }
  return null;
}

/* ================= search (paginated — bug #5, fixed in 4M) ================= */
// 4W: the ONLY accepted filter values. VERIFIED against the installed youtubei.js 18.0.0:
//   MusicSearchType = 'all' | 'song' | 'video' | 'album' | 'playlist' | 'artist'
//                      (dist/src/types/Misc.d.ts:34)
//   Music.search(query, filters) encodes filters.type into the protobuf
//   SearchFilter{ filters: { musicSearchType: { [type]: true } } } — the message's real
//   fields are song/video/album/artist/playlist
//                      (dist/src/core/clients/Music.js:104, dist/protos/generated/misc/params.d.ts:57)
//   `filters.type === 'all'` short-circuits and leaves `params` undefined — the UNFILTERED
//   search, byte-identical to omitting `type` entirely (verified live: both return the same
//   32 rows / same first titles). 'playlist' is a real filter but is deliberately NOT exposed.
const SEARCH_TYPES = ['all', 'song', 'video', 'album', 'artist'];
// undefined / absent / '' -> 'song', which is EXACTLY the pre-4W behaviour other callers rely on
// (e.g. openAlbum's `/api/search?q=<title>` fallback omits `type`). An explicit value must be in
// the allowlist, otherwise the route answers 400 — never a silent substitute, never a Songs default.
// Verified: an unknown type reaches the library as an unset protobuf field and silently returns
// ZERO rows, so validating here is the only thing standing between a typo and an empty page.
function searchTypeOf(raw){
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'song';
  const t = String(raw).trim().toLowerCase();
  return SEARCH_TYPES.indexOf(t) >= 0 ? t : null;
}
const searchSessions = new Map();          // sessionId -> { feed, shelf, seen, type, reqs, rows, expires }
const SESSION_TTL = 10 * 60 * 1000;
// 4M: per-session caps so a client cannot paginate one search forever.
const SEARCH_PAGE_MAX = 3;                 // max /api/search/next calls per session
const SEARCH_ROW_MAX = 100;                // max fresh rows a session may deliver

function sweepSessions(){
  const now = Date.now();
  for (const [k, v] of searchSessions) if (v.expires < now) searchSessions.delete(k);
  if (searchSessions.size > 60) {
    const oldest = [...searchSessions.entries()].sort((a, b) => a[1].expires - b[1].expires);
    oldest.slice(0, searchSessions.size - 60).forEach(([k]) => searchSessions.delete(k));
  }
}
function newSessionId(){
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
// 4M: the REAL "load more" token on a parsed search page. Measured live (18.0.0):
//   • page-1 MusicShelf has NO ContinuationItem child — the token is hoisted onto
//     shelf.continuation (from continuations[0].nextContinuationData, MusicShelf.js).
//   • shelf.getContinuation() / feed.getContinuation() DO NOT EXIST on these parsed nodes,
//     so the old pageFrom() always returned null → /api/search/next silently answered
//     { items: [], next: false }. That is the bug.
// Same request shape /api/artist/songs uses for its continuation (parse: true + memo read),
// pointed at /search with the shelf token — the request the library's own SearchContinuation
// makes (Search.js getContinuation). Rows come back through continuation_contents_memo,
// the NEXT token rides on continuation_contents.continuation.
//   shelf in the session = page-1 MusicShelf, then the stored next token (string or node).
// Returns { rows, nextCont } or null — never throws past the caller's try/catch.
async function pageFrom(shelf, feed){
  const youtube = await getYt();
  let resp = null, memo = null;
  if (shelf && typeof shelf.continuation === 'string' && shelf.continuation) {
    // token string hoisted onto the shelf (page 1 and every page after)
    resp = await youtube.actions.execute('/search', { continuation: shelf.continuation, client: 'YTMUSIC', parse: true });
    memo = resp && (resp.continuation_contents_memo || resp.on_response_received_actions_memo || resp.contents_memo);
  } else {
    // defensive: legacy shapes — a bare ContinuationItem, or one sitting inside shelf.contents
    const cont = (shelf && shelf.type === 'ContinuationItem') ? shelf
      : (shelf && Array.isArray(shelf.contents)) ? shelf.contents.find(x => x && x.type === 'ContinuationItem') : null;
    if (!cont || !cont.endpoint || typeof cont.endpoint.call !== 'function') return null;
    resp = await cont.endpoint.call(youtube.actions, { client: 'YTMUSIC', parse: true });
    memo = resp && (resp.continuation_contents_memo || resp.on_response_received_actions_memo || resp.contents_memo);
  }
  if (!memo || typeof memo.getType !== 'function') return null;
  const rows = YTNodes.MusicResponsiveListItem ? memo.getType(YTNodes.MusicResponsiveListItem) : [];
  const lc = resp && resp.continuation_contents;
  const nextCont = (lc && lc.continuation) ||
    (YTNodes.ContinuationItem ? (memo.getType(YTNodes.ContinuationItem)[0] || null) : null);
  return { rows, nextCont };
}
function dedupe(items, seen){
  const out = [];
  for (const it of items) {
    if (!it || !it.id || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

/* ================= 4AB: type=artist row filter (artist searches only) =================
   A type=artist batch mixes the real artist with fan/duplicate channels. Two rules:
     1. drop every row whose sub starts with "Profile" — the fan-channel form "Profile • @handle";
     2. collapse EXACT normalised-name duplicates, keeping the row with the LARGER parsed audience.
   The normalisation is the same one the All card's picker uses (index.html trNorm): lowercase,
   diacritics stripped, punctuation -> space, spaces collapsed, a leading "the" dropped. The
   audience parse is trAudience's K/M/B rule ("331M monthly audience" -> 331000000,
   "1.66K subscribers" -> 1660). A small subscriber count is NEVER a reason to drop a row: small
   real artists must survive. Rows whose normalised names differ are different people and both
   stay. Order is YouTube's own — a winner replaces its twin in the earlier slot, never reordered. */
function artistNameKey(s){
  let t = String(s == null ? '' : s).toLowerCase();
  try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
  t = t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.replace(/^the\s+/, '');
}
// '331M monthly audience' / '1.66K subscribers' -> a number (K/M/B multipliers). A value that is
// NOT a real audience (the digits inside a @handle) never parses: the unit needs a word boundary.
function subAudience(sub){
  const s = String(sub == null ? '' : sub).toLowerCase().replace(/,/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*([kmb])\b/) || s.match(/(\d+(?:\.\d+)?)\s*subscribers?\b/);
  if (!m) return 0;
  const n = parseFloat(m[1]); if (!(n > 0)) return 0;
  const u = m[2] || '';
  return Math.round(n * (u === 'k' ? 1e3 : u === 'm' ? 1e6 : u === 'b' ? 1e9 : 1));
}
function filterArtistRows(rows){
  // rule 1: the fan-channel form "Profile • @handle" is never an artist
  const list = (rows || []).filter(r => r && !(String(r.sub || '').trim().indexOf('Profile') === 0));
  // rule 2, pass 1: the winner of each exact normalised name = the larger parsed audience.
  // Replaced only on a STRICTLY larger audience, so the earlier row wins a tie or when neither
  // sub parses (a subscriber count of 5 is small, not junk — it never triggers a drop here).
  const win = new Map();
  for (const r of list) {
    const k = artistNameKey(r.title || r.artist || '');
    if (!k) continue;                                   // nameless rows can never collide
    const cur = win.get(k);
    if (!cur || subAudience(r.sub) > subAudience(cur.sub)) win.set(k, r);
  }
  // pass 2: drop the losers, keep every winner in YouTube's own slot — the result is a plain
  // subsequence of the input, so nothing is ever reordered.
  return list.filter(r => {
    const k = artistNameKey(r.title || r.artist || '');
    return !k || win.get(k) === r;
  });
}

/* ================= 4Z-b: type=all enrichment =================
   4Z-b: type=all is ONE unfiltered YouTube batch, and it is incomplete in two measured ways
   (18.0.0):
     • many artist queries carry NO real artist row, only fan "Profile" channels — "arijit singh",
       "the weeknd", "billie eilish", "coldplay" all lack the real artist (measured live), so the
       top-result card had nothing to name;
     • many songs publish NO credits at all — "Starboy (feat. Daft Punk)", "Blinding Lights",
       "Main Na Raha Mera" arrive with artist:"" and artists:[], so the row reads "Song • 3:51".
   The category searches for the SAME query DO carry both (verified: type=song gives Starboy
   artist "The Weeknd"; type=artist row 1 is "The Weeknd" 241M / "Arijit Singh" 665M). So type=all
   additionally runs song+album+artist IN PARALLEL and merges them. Category types never call this
   code and stay byte-identical. No new deps; reuses mapTrack()/collectItems()/rowLabel(). */
const ALL_MERGE_CAP = 40;                     // max RENDERABLE rows (kind!=='other') the All list may return
function mapSearchRows(feed, type){
  // identical mapping to the route's own expression — same normaliser, same row labels
  return collectItems(feed.contents || [], [])
    .map(i => mapTrack(i, '', type === 'album' || i.type === 'MusicTwoRowItem', true))
    .filter(i => i && i.id);
}
// every rendered row carries an id (mapTrack drops id-less rows); the title+kind key is a cautious
// fallback so two different id-less songs that only share a title never merge or de-dupe together.
function mergeKey(it){
  return (it && it.id) ? 'id:' + it.id
    : 't:' + ((it && it.kind) || '') + ':' + String((it && it.title) || '').toLowerCase();
}
function nameKey(s){ return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase() }
// BACKFILL: never overwrite a non-empty field — only fill what the base row is missing.
function backfillRow(dst, src){
  if (!dst.artist && src.artist) dst.artist = src.artist;
  if (src.artists && src.artists.length){
    if (!dst.artists || !dst.artists.length) dst.artists = src.artists.slice();
    else {
      const byName = new Map();
      for (const a of src.artists) if (a && a.name) byName.set(nameKey(a.name), a);
      for (const a of dst.artists) if (a && !a.id){ const m = byName.get(nameKey(a.name)); if (m && m.id) a.id = m.id }
    }
  }
  if (!dst.duration && src.duration) dst.duration = src.duration;
  if (!dst.thumb && src.thumb) dst.thumb = src.thumb;
  if (!dst.sub && src.sub) dst.sub = src.sub;
}
// Merge the category searches into the unfiltered batch. Order: YouTube's unfiltered rows first,
// then the category rows that are not present. `groups` is [song, album, artist] and the append is
// ROUND-ROBIN (one row from each group per pass) so no single category floods the list and albums
// AND artists both stay in the mix. Id-bearing duplicates are backfilled; id-less rows use the
// cautious key and are only skipped when it already exists (never merged across a title).
// 4Z-b-1 — THE ONE EXCEPTION to "base order is preserved": the guarded song promotion below.
// Measured on "aasa kooda": the unfiltered batch floats three kind:'track' label:'Video' covers
// ("…Live Singing…", "…Slap Remix…") above the canonical kind:'track' label:'Song' row
// rVqcPUQ2YXI, which the type=song page 1 puts at index 0. The covers' titles are NOT equal to
// the song's, so no exact-title (or dedupe) rule could ever reach this — only the song category
// search knows which row is the canonical song. So: if that category's OWN top row looks like the
// query AND the All list already carries the same id as a Song row with at least one Video row in
// front of it, that Song row is lifted to just before the first such Video row. Nothing is added
// or dropped, every other row keeps its relative order, and the length never exceeds ALL_MERGE_CAP.
// EVERY guard is mandatory; if any one fails this is a plain no-op, and the heuristic is never
// widened to a fuzzier title match (a wrong promotion is worse than a wrong order).
function mergeAllRows(base, groups, query){
  const out = base.slice();
  const at = new Map();
  out.forEach((it, i) => at.set(mergeKey(it), i));
  for (const group of groups) for (const src of group){
    if (!src.id) continue;
    const i = at.get('id:' + src.id);
    if (i != null) backfillRow(out[i], src);
  }
  let rendered = out.reduce((n, it) => n + ((it && it.kind) === 'other' ? 0 : 1), 0);
  for (let i = 0; rendered < ALL_MERGE_CAP; i++){
    let advanced = false;
    for (const group of groups){
      if (i >= group.length) continue;
      advanced = true;
      const src = group[i];
      if (!src || src.kind === 'other') continue;        // same drop-the-unrenderable rule as paintSearch
      const k = mergeKey(src);
      if (at.has(k)) continue;
      if (rendered >= ALL_MERGE_CAP) break;
      at.set(k, out.length);
      out.push(src);
      rendered++;
    }
    if (!advanced) break;
  }
  // 4Z-b-1: the guarded song promotion — see the header comment above for the full rationale.
  const qKey = artistNameKey(query);              // same normaliser as the artist filter: lowercase,
  const topSong = groups[0] && groups[0][0];      // diacritics stripped, punctuation -> space,
  if (topSong && topSong.id                     // spaces collapsed, a leading "the" dropped
      && topSong.label === 'Song'               // (a) the song search's top row is a real Song row
      && qKey && artistNameKey(topSong.title).indexOf(qKey) === 0) {   // (b) title starts with the query
    const songAt = out.findIndex(it => it && it.id === topSong.id && it.label === 'Song');  // (c)
    if (songAt > 0) {
      let firstVideo = -1;                      // (d) the first label:'Video' row in front of it
      for (let i = 0; i < songAt; i++) if (out[i] && out[i].label === 'Video') { firstVideo = i; break; }
      if (firstVideo > -1) {
        const moved = out.splice(songAt, 1)[0];   // splice-out first: songAt > firstVideo, so the
        out.splice(firstVideo, 0, moved);         // earlier index is still valid for the insert.
      }
    }
  }
  return out;
}

app.get('/api/search', async (req, res) => {
  noStore(res);                     // 4AK: the sessionId in this body dies with the process (see above)
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [], next: false });
  const type = searchTypeOf(req.query.type);
  // 4W: an explicit-but-unknown type is a client bug — say so (HTTP 400 + JSON), because the
  // library would otherwise answer 200 with an unusable empty result and nobody would notice.
  if (!type) return res.status(400).json({ items: [], next: false, error: 'unknown type: ' + String(req.query.type) });
  try {
    const youtube = await getYt();
    // 4Z-b: for All, start the three category searches NOW so they run in parallel WITH the
    // unfiltered batch — one round trip instead of two. A category request never builds this
    // promise (catP stays null) and its code path below is untouched.
    const catP = (type === 'all')
      ? Promise.all([
          youtube.music.search(q, { type: 'song' }),
          youtube.music.search(q, { type: 'album' }),
          youtube.music.search(q, { type: 'artist' })
        ])
      : null;
    if (catP) catP.catch(() => {});   // attach a handler now — the real await below reports the failure
    // type=all -> the unfiltered search (no type option at all); category -> its verified value.
    const feed = await youtube.music.search(q, type === 'all' ? {} : { type });
    const shelf = findMusicShelf(feed.contents || [], 0);
    let items = collectItems(feed.contents || [], [])
      // 4W-D2: the unfiltered list is the ONLY one that mixes row types, so it — and only it —
      // asks for the per-row type label ("Song • The Weeknd • 3:51"). A category list is
      // single-typed and keeps the subtitle it has always had.
      .map(i => mapTrack(i, '', type === 'album' || i.type === 'MusicTwoRowItem', type === 'all'))
      .filter(i => i && i.id);
    // 4Z-b: only the unfiltered list is enriched — and it is enriched from the SAME query's
    // category searches, which were started ABOVE so all four requests run in parallel.
    if (type === 'all' && catP) {
      try {
        const cats = await catP;   // [song, album, artist]
        items = mergeAllRows(items, [mapSearchRows(cats[0], 'song'), mapSearchRows(cats[1], 'album'), mapSearchRows(cats[2], 'artist')], q);
      } catch (e) {
        // soft-fail: keep YouTube's honest unfiltered batch rather than 500 the whole search
        console.error('all merge error (soft-fail):', e.message);
      }
    }
    // 4AB: a type=artist batch mixes the real artist with fan/duplicate channels. The filter runs
    // AFTER the All merge so type=all stays byte-identical, and BEFORE the session/seen set is
    // built so a dropped row can never be resurrected by a continuation page.
    if (type === 'artist') items = filterArtistRows(items);
    const seen = new Set(items.map(i => i.id));
    sweepSessions();
    const sessionId = newSessionId();
    // 4M: honest hasMore = we actually hold a usable token — shelf.continuation
    // (page-1 shape) or a ContinuationItem in the contents (legacy shape).
    // 4Z-b: All is a single batch and never paginates — never advertise a token it cannot use.
    // Categories keep their real continuation (page 1 + /api/search/next), exactly as before.
    const hasMore = (type !== 'all') && !!(shelf && (shelf.continuation || (shelf.contents || []).some(x => x && x.type === 'ContinuationItem')));
    searchSessions.set(sessionId, { feed, shelf, seen, type, reqs: 0, rows: items.length, expires: Date.now() + SESSION_TTL });
    res.json({ items, sessionId, next: hasMore });
  } catch (e) {
    console.error('search error:', e.message);
    res.json({ items: [], next: false, error: String(e.message || e) });
  }
});

app.get('/api/search/next', async (req, res) => {
  noStore(res);                     // 4AK: pagination pages are never cached
  const sessionId = String(req.query.sessionId || '');
  const s = searchSessions.get(sessionId);
  if (!s) return res.json({ items: [], next: false, error: 'session expired' });
  // 4M: cap the session — page 1 plus at most SEARCH_PAGE_MAX calls / SEARCH_ROW_MAX rows.
  if (s.reqs >= SEARCH_PAGE_MAX || s.rows >= SEARCH_ROW_MAX) {
    searchSessions.delete(sessionId);
    return res.json({ items: [], next: false, error: 'search page limit reached' });
  }
  s.expires = Date.now() + SESSION_TTL;
  try {
    const page = await pageFrom(s.shelf, s.feed);
    if (!page) {
      searchSessions.delete(sessionId);
      return res.json({ items: [], next: false, error: 'no continuation token on the last search page' });
    }
    // 4M: store the next token in the shape pageFrom consumes — { continuation: 'token' }.
    // nextCont is the token string from continuation_contents (MusicShelfContinuation),
    // or a ContinuationItem node on the legacy shape.
    s.shelf = page.nextCont
      ? (typeof page.nextCont === 'string' ? { continuation: page.nextCont } : page.nextCont)
      : null;
    s.reqs++;
    const mapped = (page.rows || [])
      .map(i => mapTrack(i, '', s.type === 'album' || s.type === 'artist'))
      .filter(Boolean);
    // 4AB: the same artist filter as /api/search, applied to this page's mapped rows
    const fresh = dedupe(s.type === 'artist' ? filterArtistRows(mapped) : mapped, s.seen);
    s.rows += fresh.length;
    const stillMore = !!page.nextCont;
    if (!stillMore) searchSessions.delete(sessionId);
    // 4M: never a silent empty page — YouTube advertised more but this page delivered 0 new
    // tracks, so say so explicitly and end paging (next:false) instead of { items: [], next: ? }.
    if (stillMore && !fresh.length) {
      searchSessions.delete(sessionId);
      return res.json({ items: [], next: false, error: 'expected more results but ' + (page.rows || []).length + ' continuation rows mapped to 0 new tracks' });
    }
    res.json({ items: fresh, next: stillMore });
  } catch (e) {
    console.error('search next error:', e.message);
    searchSessions.delete(sessionId);
    res.json({ items: [], next: false, error: String(e.message || e) });
  }
});

/* ================= radio (bugs #8 + #9) ================= */
// YouTube Music's own "up next" for a seed song = similar-vibe, not same-artist.
// pull a thumbnail out of whatever shape YouTube returns
function thumbsOf(it){
  const cands = [it && it.thumbnail, it && it.thumbnails];
  for (const c of cands){
    if (!c) continue;
    if (Array.isArray(c)) return c;
    if (Array.isArray(c.contents)) return c.contents;       // parsed youtubei.js node
    if (Array.isArray(c.thumbnails)) return c.thumbnails;   // raw node
    if (c.url) return [c];                                  // single object
  }
  return [];
}
// artist line: short_byline → long_byline → subtitle → author → album
function byline(it){
  const tries = [
    it && it.short_byline,
    it && it.long_byline,
    it && it.subtitle,
    it && it.author && it.author.name,
    it && it.album && it.album.name,
    it && it.artists
  ];
  for (const c of tries){
    let s = txt(c);
    if (!s && c && typeof c === 'object' && c.name) s = txt(c.name);
    s = String(s).replace(/\s*[•·]\s*/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
    if (s) return s;
  }
  return '';
}
// last-resort still: 16:9, so a square cover-crop shows no letterbox bars
/* WAVE 13: sddefault (640x480), not mqdefault (320x180). This still is the artwork for a row the
   API shipped without one, and it is drawn in boxes up to 458px wide (a Trending hero card) —
   320px of image upscaled 1.4x was the softest artwork on the page. sddefault exists for every
   video, so no new failure path is introduced (verified: 200 on live ids, ~35KB). */
function ytStill(id){ return 'https://i.ytimg.com/vi/' + id + '/sddefault.jpg'; }

app.get('/api/radio', async (req, res) => {
  cacheHeaders(res, '/api/radio');
  const id = String(req.query.id || '');
  const title = String(req.query.title || '');
  const artist = String(req.query.artist || '');
  const want = Math.min(30, Math.max(1, parseInt(req.query.n, 10) || 15));
  try {
    const youtube = await getYt();

    // 1) real radio
    if (id && typeof youtube.music.getUpNext === 'function') {
      try {
        const panel = await youtube.music.getUpNext(id);
        const raw = panel?.contents || [];
        const items = [];
        for (const node of raw) {
          const it = node?.primary || node;
          const vid = it?.video_id || it?.id;
          if (!vid || vid === id) continue;
          const art = bestUrl(thumbsOf(it));
          /* 4AP: the panel node has NO byline fields on singles — byline() then fell through to
             `it.album.name`, which equals the track title, so the artist WAS the title. Use the
             structured credit first (artists[] → authors[] → author, via extractArtist) and only
             fall back to byline() when there is none; then never let a title-only string out. */
          const rTitle = txt(it.title);
          let rArtist = extractArtist(it) || byline(it);
          if (isTitleOnlyCredit(rArtist, rTitle)) rArtist = '';
          items.push({
            id: vid,
            kind: 'track',
            title: rTitle,
            artist: rArtist,
            artists: artistList(it),
            sub: '',
            thumb: art || ytStill(vid),
            duration: txt(it.length_text) || txt(it.duration?.text) || ''
          });
        }
        const seen = new Set([id]);
        const clean = dedupe(items, seen).slice(0, want);
        if (clean.length) return res.json({ items: clean, source: 'radio' });
      } catch (e) {
        console.error('radio error (falling back):', e.message);
      }
    }

    // 2) fallback — "song + similar" style search, still genre-first
    const term = [title, artist].filter(Boolean).join(' ').trim();
    if (!term) return res.json({ items: [], source: 'none' });
    const s = await youtube.music.search(term, { type: 'song' });
    const seen = new Set(id ? [id] : []);
    const items = dedupe(
      collectItems(s.contents || [], []).map(i => mapTrack(i, '', false)).filter(Boolean),
      seen
    ).slice(0, want);
    res.json({ items, source: 'search' });
  } catch (e) {
    console.error('radio error:', e.message);
    res.json({ items: [], source: 'error', error: String(e.message || e) });
  }
});


/* ================= album ================= */
app.get('/api/album', async (req, res) => {
  cacheHeaders(res, '/api/album');
  const id = String(req.query.id || '');
  if (!id) return res.json({ tracks: [], error: 'missing id' });
  try {
    const youtube = await getYt();
    const a = await youtube.music.getAlbum(id);
    // youtubei.js 18 has no `tracks`/`title`/`thumbnail` on Album — it exposes
    // header + contents + sections. header is MusicResponsiveHeader (current pages)
    // or MusicDetailHeader (older pages, which uses `thumbnails` and `author`).
    const h = a.header || {};
    const thumb = bestUrl(h.thumbnail?.contents || h.thumbnails) || '';
    const artist = txt(h.strapline_text_one) || txt(h.author?.name) || '';
    const tracks = collectItems(a.contents || a.tracks || [], [])
      .map(t => mapTrack(t, thumb, false))
      .filter(t => t && t.id)
      .map(t => ({ ...t, thumb: t.thumb || thumb, artist: t.artist || artist }));
    if (!tracks.length) return res.json({ tracks: [], error: 'Album has no playable tracks' });
    res.json({ id: a.id || id, title: txt(h.title), artist, thumb, tracks });
  } catch (e) {
    console.error('album error:', e.message);
    res.json({ tracks: [], error: String(e.message || e) });
  }
});

/* ================= artist (Wave 2 §9.1 — server-side only) ================= */
// Two-row carousel entry (album/EP) → track/album-shaped object
function mapCarouselItem(i){
  try {
    return {
      id: i.id,
      kind: i.item_type === 'album' ? 'album' : 'track',
      title: txt(i.title),
      artist: (i.artists || []).map(a => txt(a && a.name)).filter(Boolean).join(', '),
      artists: artistList(i),
      sub: '',
      thumb: bestUrl(Array.isArray(i.thumbnail) ? i.thumbnail : (i.thumbnail && i.thumbnail.contents) || i.thumbnails || []),
      year: i.year || ''
    };
  } catch (e) { return null; }
}
// related-artist carousel entry → { name, id, audience, thumb }
function mapRelatedArtist(i){
  try {
    return {
      name: txt(i.title),
      id: i.id || null,
      audience: txt(i.subtitle),
      thumb: bestUrl(Array.isArray(i.thumbnail) ? i.thumbnail : (i.thumbnail && i.thumbnail.contents) || i.thumbnails || [])
    };
  } catch (e) { return null; }
}
/* ===== WAVE 19 — WHO A NAME ACTUALLY IS =========================================================
   Reported: a 9:57 re-upload credited to "Honey Singh" opened an artist page whose hero read "Honey
   Singh" and whose body was EMPTY, while the real artist is called "Yo Yo Honey Singh" — and the
   lyrics panel ran the official 4:14 recording's timings under it. Reproduced live on this route:
   GET /api/artist?name=Honey%20Singh answered { id: "UCOZ5kxDXTaromQbnn4F5w8g", name: "Honey Singh" }
   — a 13-subscriber channel that browses to a header and NOTHING else (0 top songs, 0 albums,
   0 related, empty description) — while the artist search for that very string had "Yo Yo Honey
   Singh — Artist • 289M monthly audience" as its FIRST row. The old resolver kept the exact-name
   match and never looked at what was behind it.
   WHAT CHANGED, and nothing else: the candidate list is ORDERED (exact real entities → exact
   channels → real entities whose name CONTAINS the whole query as a run of whole words — the alias
   direction, "Yo Yo Honey Singh" ⊇ "Honey Singh"), the first three are BROWSED, and the first one
   that is an actual page wins. An exact name that browses to nothing therefore no longer beats a
   real artist whose name contains it, and when no candidate is a page at all the route answers
   { id: null } — which the client already renders as plain text — instead of a finished-looking
   but empty hero.
   THE EXACT NAME IS STILL FIRST AMONG EQUALS: a small artist whose page really exists is never
   passed over for a bigger name that merely contains theirs, because the alias step only ever runs
   after an exact-name candidate turned out to have nothing on it. The one extra browse this costs
   is paid only on those dead ends (results are cached for 30 minutes like every other /api reply).
   THE ID PATH IS UNTOUCHED: an explicitly clicked channel id is browsed exactly as before, so the
   related-artist carousels and the song rows' own artist ids keep their present behaviour. */
async function browseArtistPage(youtube, id){
  const raw = await youtube.actions.execute('/browse', { browseId: id, client: 'YTMUSIC' });
  const data = raw && raw.data;
  if (!data || data.header == null) return null;
  const page = Parser.parseResponse(data);
  const header = (page.header && page.header.item && page.header.item()) || null;
  const hdrRaw = data.header.musicImmersiveHeaderRenderer
    || data.header.musicVisualHeaderRenderer
    || data.header.musicHeaderRenderer || {};
  const ht = header && header.thumbnail;
  const thumbSrc = Array.isArray(ht) ? ht : (ht && ht.contents) || (header && header.thumbnails) || [];
  const memo = page.contents_memo;
  const shelves = memo && YTNodes.MusicShelf ? memo.getType(YTNodes.MusicShelf) : [];
  const carousels = memo && YTNodes.MusicCarouselShelf ? memo.getType(YTNodes.MusicCarouselShelf) : [];
  return { header, hdrRaw, thumbSrc, shelves, carousels };
}
/* one browsed page → exactly the fields this route has always answered with */
function readArtistPage(p, fallbackName){
  const topShelf = p.shelves.find(s => s.title && s.title.text === 'Top songs') || p.shelves[0];
  const topSongs = topShelf ? (topShelf.contents || []).map(i => mapTrack(i, '', false)).filter(t => t && t.id) : [];
  // classify carousels by item type (language-independent): album → Albums & singles, artist → related
  const albums = [], related = [], seenAlbum = new Set();
  for (const c of p.carousels) {
    const items = c.contents || [];
    const t0 = items[0] && items[0].item_type;
    if (t0 === 'album') {
      for (const it of items) {
        const m = mapCarouselItem(it);
        if (m && m.id && !seenAlbum.has(m.id)) { seenAlbum.add(m.id); albums.push(m); }
      }
    } else if (t0 === 'artist') {
      for (const it of items) { const r = mapRelatedArtist(it); if (r && r.id) related.push(r); }
    }
  }
  return {
    name: txt(p.header && p.header.title) || fallbackName || '',
    description: txt(p.header && p.header.description),
    monthlyAudience: txt(p.hdrRaw.monthlyListenerCount),
    banner: bestUrl(p.thumbSrc),
    thumb: bestUrl((p.header && p.header.foreground_thumbnail) || p.thumbSrc),
    topSongs, albums, related
  };
}
/* nothing to show = not an artist page (measured on the 13-subscriber channel above) */
function artistPageEmpty(a){ return !a.topSongs.length && !a.albums.length && !a.related.length && !a.description }
async function artistIdCandidates(youtube, wantName){
  const s = await youtube.music.search(wantName, { type: 'artist' });
  const rows = collectItems(s.contents || [], []).filter(r => r && r.id && String(r.id).startsWith('UC'));
  const nm = r => txt(r.name) || txt(r.title);
  // EXACT name only — never rows[0]. A fuzzy fallback silently opens an unrelated artist (measured:
  // "Study" → "Lofi Beat Study", "Dan" → "Dan Bull"), which is exactly the wrong-identity page this
  // route must not produce. Unknown ⇒ plain text.
  const norm = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
  const entity = r => /monthly\s*audience/i.test(txt(r.subtitle));   // "Artist • 289M monthly audience"
  const want = norm(wantName);
  const words = want.split(' ').filter(Boolean);
  const containsRun = r => {
    const t = norm(nm(r)).split(' ').filter(Boolean);
    for (let i = 0; i + words.length <= t.length; i++) if (words.every((w, k) => t[i + k] === w)) return true;
    return false;
  };
  const exact = rows.filter(r => norm(nm(r)) === want);
  const out = [], seen = new Set();
  const add = r => { if (r && r.id && !seen.has(r.id)) { seen.add(r.id); out.push(r.id) } };
  exact.filter(entity).forEach(add);
  exact.filter(r => !entity(r)).forEach(add);
  rows.filter(r => entity(r) && norm(nm(r)) !== want && containsRun(r)).forEach(add);
  return out;
}
app.get('/api/artist', async (req, res) => {
  cacheHeaders(res, '/api/artist');
  const wantId = String(req.query.id || '').trim();
  const wantName = String(req.query.name || '').trim();
  if (!wantId && !wantName) return res.json({ id: null, error: 'missing id or name' });
  try {
    const youtube = await getYt();
    let id = wantId, ready = null;

    if (!id) {
      const cands = (await artistIdCandidates(youtube, wantName)).slice(0, 3);
      if (!cands.length) return res.json({ id: null });
      for (const cid of cands) {
        const page = await browseArtistPage(youtube, cid);
        if (!page) continue;
        const read = readArtistPage(page, wantName);
        if (artistPageEmpty(read)) continue;            // a header with no catalogue is not a page
        ready = { id: cid, read };
        break;
      }
      if (!ready) return res.json({ id: null, error: 'no artist page' });
      id = ready.id;
    }
    if (!/^UC/.test(id) && !id.startsWith('FEmusic_library_privately_owned_artist')) {
      return res.json({ id: null, error: 'invalid artist id' });
    }

    let read = ready ? ready.read : null;
    if (!read) {
      const page = await browseArtistPage(youtube, id);
      if (!page) return res.json({ id: null, error: 'artist not found' });
      read = readArtistPage(page, wantName);            // the id path keeps serving what it browsed
    }
    res.json(Object.assign({ id }, read));
  } catch (e) {
    console.error('artist error:', e.message);
    res.json({ id: null, error: String(e.message || e) });
  }
});

/* ================= artist songs (Wave 4A — full catalogue for "Play all" / "Mix") ================= */
// GET /api/artist/songs?id=<UC…>  →  { id, name, total, songs: [Track] }
// Verified live on youtubei.js 18.0.0 (`Artist.getAllSongs()` → MusicPlaylistShelf):
//   • 100 MusicResponsiveListItem rows arrive in ONE request, + a ContinuationItem.
//   • every row carries a playable video id (`playlistItemData.videoId` → `i.id`) and `duration.text`.
//   • channel ids are on `artists[].channel_id` (song rows) / `authors[]` / `author`.
//   • NOT parsed on these rows: album name and play count. The album is `flex_columns[3]`,
//     the play count `flex_columns[2]` (§6 decision 7: play counts dropped).
//   • ONE continuation request returns the remaining ~50 rows, then the list ends
//     (observed 148–150 total per artist, 83 for a small catalogue). Capped at 2 extra requests.
function flexText(item, i){
  try { return txt((item.flex_columns || [])[i] && (item.flex_columns || [])[i].title); }
  catch (e) { return ''; }
}
// the artist line always sits in flex_columns[1]; `artists` is the id-bearing source but YouTube
// occasionally serves a row whose parsed `artists` is empty — then this is the only name text left.
function flexArtistLine(item){
  try {
    const runs = ((((item.flex_columns || [])[1] || {}).title) || {}).runs || [];
    return runs.map(r => txt(r.text)).join('').replace(/\s+/g, ' ').trim();
  } catch (e) { return ''; }
}
// mapTrack's frozen Track shape, with the album name folded into `sub` (the under-title line).
function mapArtistSongRow(i, artistName){
  const t = mapTrack(i, '', false);
  if (!t) return null;
  if (!t.artist) t.artist = flexArtistLine(i) || artistName || '';
  // flex_columns[3] is the album on `song` rows; on `video` rows it is a title duplicate, so skip those.
  if (!t.sub && i.item_type === 'song') t.sub = flexText(i, 3);
  return t;
}
async function artistSongRows(youtube, artist){
  const shelf = await artist.getAllSongs();                       // throws when there is no Top songs shelf
  const nodes = (shelf && shelf.contents) || [];
  const seen = new Set();
  const out = [];
  const push = list => {
    for (const it of list) if (it && it.id && !seen.has(it.id)) { seen.add(it.id); out.push(it); }
  };
  push(nodes.filter(n => n && n.type === 'MusicResponsiveListItem'));
  let cont = nodes.find(n => n && n.type === 'ContinuationItem') || null;
  let pages = 1;
  while (cont && pages < 3 && out.length < 300) {
    const resp = await cont.endpoint.call(youtube.actions, { client: 'YTMUSIC', parse: true });
    const memo = resp && (resp.on_response_received_actions_memo || resp.contents_memo);
    if (!memo || typeof memo.getType !== 'function') break;
    const items = YTNodes.MusicResponsiveListItem ? memo.getType(YTNodes.MusicResponsiveListItem) : [];
    if (!items.length) break;
    push(items);
    cont = YTNodes.ContinuationItem ? (memo.getType(YTNodes.ContinuationItem)[0] || null) : null;
    pages++;
  }
  return out;
}
app.get('/api/artist/songs', async (req, res) => {
  cacheHeaders(res, '/api/artist/songs');
  const id = String(req.query.id || '').trim();
  const wantName = String(req.query.name || '').trim();
  if (!id) return res.json({ id: null, name: wantName, total: 0, songs: [], error: 'missing id' });
  try {
    if (!/^UC/.test(id) && !id.startsWith('FEmusic_library_privately_owned_artist')) {
      return res.json({ id: null, name: wantName, total: 0, songs: [], error: 'invalid artist id' });
    }
    const youtube = await getYt();
    const artist = await youtube.music.getArtist(id);
    const name = txt(artist && artist.header && artist.header.title) || wantName;
    let rows = [];
    try {
      rows = await artistSongRows(youtube, artist);
    } catch (e) {
      // no Top songs shelf (very small artist) or the shelf endpoint failed — soft-fail, never 500
      return res.json({ id, name, total: 0, songs: [], error: String(e.message || e) });
    }
    const songs = rows.map(i => mapArtistSongRow(i, name)).filter(t => t && t.id);
    res.json({ id, name, total: songs.length, songs });
  } catch (e) {
    console.error('artist songs error:', e.message);
    res.json({ id, name: wantName, total: 0, songs: [], error: String(e.message || e) });
  }
});

/* ================= search suggestions ================= */
app.get('/api/suggest', async (req, res) => {
  cacheHeaders(res, '/api/suggest');
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  try {
    const youtube = await getYt();
    if (typeof youtube.getSearchSuggestions !== 'function') return res.json({ items: [] });
    const s = await youtube.getSearchSuggestions(q);
    const arr = Array.isArray(s) ? s : (s?.suggestions || []);
    res.json({ items: arr.map(txt).filter(Boolean).slice(0, 8) });
  } catch (e) {
    res.json({ items: [] });
  }
});

/* ================= lyrics (bug #4: real matching) ================= */
function runsToText(d){
  if (!d) return '';
  if (Array.isArray(d.runs)) return d.runs.map(r => txt(r.text)).join('\n');
  return txt(d);
}
async function ytmLyrics(id){
  if (!id) return '';
  const youtube = await getYt();
  try {
    if (typeof youtube.music.getLyrics === 'function') {
      const l = await youtube.music.getLyrics(id);
      const t = runsToText(l?.description);
      if (t) return t;
    }
  } catch (e) { /* fall through */ }
  try {
    const info = await youtube.getInfo(id);
    if (typeof info?.getLyrics === 'function') {
      const l = await info.getLyrics();
      const t = runsToText(l?.description);
      if (t) return t;
    }
  } catch (e) { /* give up */ }
  return '';
}
// --- matching helpers ---
function tokens(s){
  return String(s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft|from|official|video|lyrics?|audio|hd|full song)\b\.?/g, ' ')
    .replace(/[^a-z0-9\u0900-\u097F\u0B80-\u0BFF\u0600-\u06FF]+/g, ' ')
    .split(' ').filter(t => t && t.length > 1);
}
function jaccard(a, b){
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
function titleVariants(t){
  const raw = String(t || '').trim();
  const out = [raw];
  const stripped = raw.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== raw) out.push(stripped);
  const dashed = raw.split(/\s+[-–—]\s+/)[0].trim();
  if (dashed && !out.includes(dashed)) out.push(dashed);
  return out.filter(Boolean);
}
function artistVariants(a){
  const raw = String(a || '').trim();
  const parts = raw.split(/[,&×;]|\bfeat\.?\b|\bft\.?\b/i).map(s => s.trim()).filter(Boolean);
  const out = [raw, ...parts];
  return [...new Set(out.filter(Boolean))].slice(0, 6);
}
async function lrGet(params){
  const p = new URLSearchParams(params);
  let r;
  try {
    r = await fetchT('https://lrclib.net/api/get?' + p, {
      headers: { 'User-Agent': 'Svara/2.0 (music player)' }
    }, 7000);
  } catch (e) { return null; }        // timeout / network: treated as "no match", the lookup goes on
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}
async function lrSearch(params){
  const p = new URLSearchParams(params);
  let r;
  try {
    r = await fetchT('https://lrclib.net/api/search?' + p, {
      headers: { 'User-Agent': 'Svara/2.0 (music player)' }
    }, 7000);
  } catch (e) { return []; }
  if (!r.ok) return [];
  try { const j = await r.json(); return Array.isArray(j) ? j : []; } catch (e) { return []; }
}
async function lrclibBest({ title, artist, album, duration }){
  if (!title) return null;
  const titles = titleVariants(title);
  const artists = artistVariants(artist);
  /* 4AP: a missing / title-only artist cannot corroborate a match on its own. `artists` is EMPTY
     when artistVariants('') runs — Math.max of an empty list is -Infinity, which silently sank
     every empty-artist request to "no lyrics". Treat it as UNTRUSTED instead and gate the
     candidate on the title AND the duration (see the loop). */
  const untrusted = !artist || isTitleOnlyCredit(artist, title);
  const pool = [];
  const push = (row, how) => { if (row && (row.syncedLyrics || row.plainLyrics)) pool.push({ ...row, _how: how }); };

  // A) exact gets — no duration first (YouTube length often differs by seconds)
  for (const t of titles.slice(0, 2)) {
    for (const a of artists.slice(0, 3)) {
      push(await lrGet({ track_name: t, artist_name: a }), 'exact');
      if (duration > 0) {
        push(await lrGet({ track_name: t, artist_name: a, duration: String(Math.round(duration)) }), 'exact_dur');
      }
    }
  }
  if (album) for (const t of titles.slice(0, 1)) {
    for (const a of artists.slice(0, 2)) {
      push(await lrGet({ track_name: t, artist_name: a, album_name: album }), 'exact_album');
    }
  }

  // B) fuzzy search per artist variant + a free-text search
  if (pool.length < 4) {
    for (const t of titles.slice(0, 2)) {
      for (const a of artists.slice(0, 4)) {
        (await lrSearch({ track_name: t, artist_name: a })).slice(0, 10).forEach(r => push(r, 'search'));
      }
    }
    const ft = [titles[0], artists[0]].filter(Boolean).join(' ');
    if (ft) (await lrSearch({ q: ft })).slice(0, 10).forEach(r => push(r, 'free'));
  }
  if (!pool.length) return null;

  // C) rank: title + artist similarity + duration proximity, synced breaks ties
  const seen = new Set();
  const ranked = [];
  for (const row of pool) {
    const key = (row.id || '') + '|' + (row.artistName || '') + '|' + (row.trackName || '');
    if (seen.has(key)) continue;
    seen.add(key);
    const tScore = Math.max(...titles.map(t => jaccard(t, row.trackName || '')));
    const aScore = artists.length ? Math.max(...artists.map(a => jaccard(a, row.artistName || ''))) : 0;
    /* 4AP-b GUARD: with no trustworthy artist term, accept ONLY a SYNCED candidate — never a
       plain one (a plain same-title match is exactly the wrong-recording risk 4AP closed). The
       synced entry must also be a near-exact title match (jaccard >= 0.9) AND agree on duration
       within 5s. Verified: the untrusted title-only lookup for "Self Aware" returns only plain
       Temper City rows, so this honestly answers "no timed lyrics" instead of guessing. */
    if (untrusted){
      const durOk = duration > 0 && row.duration && Math.abs(row.duration - duration) <= 5;
      if (!row.syncedLyrics || tScore < 0.9 || !durOk) continue;
    }
    const dScore = duration > 0 && row.duration
      ? Math.max(0, 1 - Math.abs(row.duration - duration) / 12) : 0.5;
    let score = 0.5 * tScore + 0.3 * aScore + 0.2 * dScore;
    if (row._how.startsWith('exact')) score += 0.05;
    if (row.syncedLyrics) score += 0.06;                 // timed lyrics win near-ties
    /* WAVE 34: an entry whose own length is the track's length, to within a few seconds, is the
       same recording — it beats a longer/shorter cut that merely sits inside the tolerance above
       (the AZUL case: a 152s upload's timings vs the 138s master both pass `agree`). */
    if (duration > 0 && row.duration && Math.abs(row.duration - duration) <= 3) score += 0.08;
    ranked.push({ row, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  /* ===== WAVE 19 — A TITLE AND AN ARTIST ARE NOT ENOUGH; THE RECORDING HAS TO AGREE ON LENGTH ====
     Reported: "Desi Kalakaar" played from a 9:57 re-upload while the lyrics panel walked the OFFICIAL
     4:14 recording's timings — the highlight sat minutes away from the words being sung, for the
     whole song. Reconstructed against the live API: that title's rows carry the credit "Honey Singh"
     (a 13-subscriber re-upload channel) instead of "Yo Yo Honey Singh", which is enough for the
     ranker below — 0.5·title + 0.3·artist + 0.2·duration — because a 343s disagreement only costs
     the duration TERM (it floors at 0 past 12s): a perfect title with a half-matching artist still
     scored 0.56 and won. Measured: the old lookup answered 4:14's synced lyrics for a 9:57 video.
     THE RULE: a candidate is a DIFFERENT RECORDING unless its length is within max(30s, 25%) of the
     track's own. Candidates split into `agree` (inside that tolerance, or with no duration to judge
     by at all) and `off` (everything else), and only `agree` may win — a 4:14 master can still
     highlight a 5:20 upload, and a 9:57 re-upload can never borrow 4:14's clock.
     WHAT A MISMATCH BECOMES: the WORDS are almost certainly right (it is the same song, uploaded
     longer) but the TIMINGS belong to the other recording, so the row goes back FLAGGED and
     /api/lyrics publishes it as plain, unhighlighted text together with the reason. Answering
     "no lyrics" instead would deny a song LRClib clearly knows. */
  /* ...and a synced file whose LAST line lands minutes before our track ends was written for a
     shorter cut, whatever its own duration field claims. That second test is the one that catches
     the measured case: LRClib's "Desi Kalakaar" entry is filed as 598s — a 598s video asks for it and
     its duration agrees — while its 82 timed lines run 0:00 → 4:09 and end with a 3:09 tail of
     nothing. Played against a 9:57 upload its highlight is therefore already wrong at 0:41 (the
     user's screenshot: [00:40.64] "Har veervaar peer baba se bhi maanga tujhe" under an instrumental
     passage). COVERAGE is what tells the two apart, and it stays generous for honest recordings: a
     normal entry reaches ~95% of its track (a 4:14 song's timings end at 4:09), so the slack is a
     flat 90s or 20% of the track, whichever is larger. */
  const agree = [], off = [];
  const tol = duration > 0 ? Math.max(30, Math.round(duration * 0.25)) : 0;
  const cover = duration > 0 ? Math.max(90, Math.round(duration * 0.2)) : 0;
  for (const r of ranked) {
    const gap = (duration > 0 && r.row.duration) ? Math.abs(r.row.duration - duration) : null;
    const span = r.row.syncedLyrics ? lastStamp(r.row.syncedLyrics) : 0;
    const shortCut = duration > 0 && span > 0 && span + cover < duration;
    if (shortCut || (gap !== null && gap > tol)) off.push(r); else agree.push(r);
  }
  const use = agree.length ? agree : off;
  let best = use[0];
  if (!best || best.score < 0.35) return null;
  // if the winner has no timings, prefer a slightly lower synced entry when it's still a match
  if (!best.row.syncedLyrics) {
    const timed = use.find(x => x.row.syncedLyrics && x.score >= best.score - 0.12);
    if (timed) best = timed;
  }
  if (!agree.length) {
    const row = best.row;
    return Object.assign({}, row, { _durMismatch: true, _durOf: row.duration || 0,
                                    _spanTo: row.syncedLyrics ? lastStamp(row.syncedLyrics) : 0 });
  }
  return best.row;
}
/* the LAST timestamp in a synced file (seconds), 0 when it carries none — see the coverage test
   above. Every stamp of ANY shape counts (see normalizeLrc below), not just the bracketed ones. */
function lastStamp(lrc){
  return Math.round(normalizeLrc(lrc).last);
}
/* m:ss for a duration in seconds — used by the wave 19 mismatch note, and empty for 0/absent so a
   sentence can never read "the  version". */
function clock(sec){
  const s = Math.round(Number(sec) || 0);
  return s > 0 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '';
}
/* ===== WAVE 34 — EVERY TIMESTAMP SHAPE A CONTRIBUTOR CAN PASTE =================================
   Reported: playing "AZUL" showed the lyrics tab full of "00:01:37.290 ~ 00:01:39.770 Ni dell mull
   wangu tarsayi janni ae/" — numbers, not karaoke. LRClib files that row as SYNCED, but its lines
   are not LRC: they read `00:00:11.610 ~ 00:00:13.790  words` (start ~ end, no brackets at all).
   The client's parser looks for `[mm:ss]`, found none, fell through to the plain text — which is
   the same file, numbers and all. Nothing was wrong with the fetch; the shape was simply unknown.

   normalizeLrc() rewrites every shape into the one the client can highlight, word for word:
     [00:12.34] words · [01:02:03.456] words · 00:12.34 words · 00:00:12.340 words
     00:00:12.340 ~ 00:00:15.100 words · 00:12.34 - words
   A bare `mm:ss` INSIDE the words is never a stamp — AZUL's own "Kholdi ae dino pure 7:45" keeps
   its time — because a leading stamp only counts with a fraction, with hours, or when a range
   separator follows it. Header tags ([ar:], [ti:], [offset:]) and any untimed line are dropped:
   they cannot be placed on the clock, and an untimed duplicate is what the raw-number screen was.
   A file left with fewer than two timed lines is NOT synced; /api/lyrics then answers plain text
   with its "no timed lyrics" note, so one stray stamp can never drive the highlight. */
const TS3 = /^\s*\[?\s*(\d{1,3}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\s*\]?\s*/;
const TS2 = /^\s*\[?\s*(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?\s*\]?\s*/;
function fracSec(f){
  if (!f) return 0;
  return Number(f) / (f.length === 3 ? 1000 : f.length === 2 ? 100 : 10);
}
function lrcClock(sec){
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60), r = s - m * 60;
  return String(m).padStart(2, '0') + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
}
/* the leading "start [~ end]" of one line → { t, text }; t is null when the line has no stamp */
function leadStamp(line){
  let s = String(line || ''), t = null;
  for (let i = 0; i < 2; i++) {
    const m3 = s.match(TS3);
    const m = m3 || s.match(TS2);
    if (!m) break;
    const hasFrac = m3 ? m[4] !== undefined : m[3] !== undefined;
    const after = s.slice(m[0].length);
    const isRange = /^[~\u2013\u2014]\s*/.test(after) || /^-(?:\s|>)/.test(after);
    /* "pure 7:45" is words, not a stamp: no fraction, no hours, no range after it */
    if (!hasFrac && !m3 && !isRange) break;
    if (t === null) {
      t = m3 ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + fracSec(m[4])
             : Number(m[1]) * 60 + Number(m[2]) + fracSec(m[3]);
    }
    if (!isRange) { s = after; break }
    s = after.replace(/^[~\u2013\u2014]\s*|^-(?:\s|>)\s*/, '');   /* then consume the END stamp */
  }
  return { t, text: s.replace(/\s+/g, ' ').trim() };
}
function normalizeLrc(src){
  const lines = [];
  let last = 0;
  String(src || '').split(/\r\n|\r|\n/).forEach(raw => {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line) return;
    const tags = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    let stamps = [], text = line;
    if (tags.length) {
      text = line.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
      stamps = tags.map(m => Number(m[1]) * 60 + Number(m[2]) + fracSec(m[3]));
      /* WAVE 34b — the HYBRID line: a bracket stamp followed by an inline range, as in
         `[01:39.77] 00:01:37.290 ~ 00:01:39.770 Ni dell mull…` (AZUL's 36-line entry). Stripping
         the brackets alone left the range in the words, which is the raw-number screen again.
         The inner range is the finer clock (its end can equal the bracket stamp), so it wins. */
      const inner = leadStamp(text);
      if (inner.t !== null) { text = inner.text; stamps = [inner.t]; }
    } else {
      const lead = leadStamp(line);
      if (lead.t === null) return;
      stamps = [lead.t]; text = lead.text;
    }
    stamps.forEach(t => {
      if (!isFinite(t)) return;
      lines.push({ t, text });
      if (t > last) last = t;
    });
  });
  lines.sort((a, b) => a.t - b.t);
  const lrc = lines.map(l => '[' + lrcClock(l.t) + '] ' + l.text).join('\n');
  return { lrc, n: lines.length, first: lines.length ? lines[0].t : 0, last, lines };
}
/* plain lyrics with any timestamp debris removed. Applies to BOTH providers: the untimed text can
   arrive with the same prefixes a synced file uses (the AZUL row's plainLyrics is its synced text),
   and a line that is nothing BUT a stamp is dropped rather than painted as a number. */
function sanitizePlain(s){
  const out = [];
  String(s || '').split(/\r\n|\r|\n/).forEach(raw => {
    let line = raw.replace(/^\uFEFF/, '').trim();
    if (!line) { if (out.length && out[out.length - 1] !== '') out.push(''); return }
    line = line.replace(/^(?:\[[^\]]*\]\s*)+/, '');       /* [00:12.34] / [Verse] prefixes */
    const lead = leadStamp(line);
    if (lead.t !== null) line = lead.text;
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) return;
    out.push(line);
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ===== WAVE 35 — THE SYNCED POOL ==============================================================
   The two timed pills used to be two names for the same lookup: "LRClib" asked LRClib, and
   "Auto" asked LRClib and then fell back to YouTube Music. LRClib answers with whatever its
   contributors uploaded — sometimes plain text, sometimes a file that starts half a minute in
   because it was written against a music video with an intro, sometimes nothing at all — so a
   song the app knows could still open on a blank panel.

   Both timed pills now read from ONE pool, in a fixed order of preference:
       LRClib  ->  Better Lyrics (Apple TTML)  ->  LyricsPlus (Apple / Musixmatch KPOE)
   The first candidate that passes the checks below wins. The pills differ only in what happens
   when the whole pool is empty: LRClib shows the best plain text, Auto shows YouTube Music's
   plain text, and the YouTube Music pill never consults the pool at all.

   A candidate is ACCEPTED only when
     · it parses to at least two timed lines (normalizeLrc — every stamp shape, see WAVE 34), and
     · its own recording length agrees with this track's within SYNC_DUR_TOL. The API cannot hear
       the song, so length is the only honest guard against a match from a different cut; that is
       also why every adapter sends the duration it was asked for.
   A LATE first line does not disqualify a candidate — it only loses to one that keeps the intro
   (SYNC_LATE), which is the whole point of asking all three in order.

   Every request is deadline-bounded and every failure returns null: a provider that is down, slow
   or rate-limited can cost its own turn in the waterfall and nothing else. */
const SYNC_LATE = 20;      // s — a first timed line after this is missing the intro
const SYNC_DUR_TOL = 5;    // s — an accepted file must agree with the track on length by this
const LYR_UA = 'Svara/2.0 (music player)';

/* "9.615" | "00:09.615" | "4:28.165" → seconds */
function secOf(v){
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  if (/^\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  const p = s.split(':').map(Number);
  if (p.some(n => !isFinite(n))) return 0;
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return 0;
}
/* the handful of entities both providers actually emit */
function xmlText(s){
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
/* Apple-style TTML → lines. <body dur="4:28.165"> states the matched recording's own length;
   each <p begin="9.615"> is a line and its <span> children are syllables, flattened into text. */
function ttmlLines(xml){
  const src = String(xml || '');
  const dm = src.match(/<body\b[^>]*\bdur="([^"]+)"/);
  const lines = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(src))) {
    const bm = m[1].match(/\bbegin="([^"]+)"/);
    if (!bm) continue;
    const t = secOf(bm[1]);
    const text = xmlText(m[2]);
    if (!isFinite(t) || !text) continue;
    lines.push({ t, text });
  }
  lines.sort((a, b) => a.t - b.t);
  return { lines, dur: dm ? secOf(dm[1]) : 0 };
}
/* LyricsPlus /v2 "KPOE" JSON → lines. time/duration are MILLISECONDS, and the matched recording's
   length is metadata.totalDuration (same "m:ss.mmm" shape TTML uses) — or, when it is absent, the
   end of the last line. */
function kpoeLines(j){
  const src = (j && Array.isArray(j.lyrics)) ? j.lyrics : [];
  const lines = [];
  let end = 0;
  src.forEach(l => {
    const t = (Number(l && l.time) || 0) / 1000;
    const text = xmlText(String((l && l.text) || '').replace(/\n/g, ' '));
    const e = t + (Number(l && l.duration) || 0) / 1000;
    if (e > end) end = e;
    if (!text || !isFinite(t)) return;
    lines.push({ t, text });
  });
  lines.sort((a, b) => a.t - b.t);
  const md = (j && j.metadata) || {};
  const dur = secOf(md.totalDuration) || end;
  return { lines, dur };
}
/* Apple's pools sometimes put a CREDIT where the first lyric would be — LyricsPlus opens Zaalima
   with `0.00 "Zaalima - Arijit Singh (…)/Harshdeep Kaur"`, which looks like a file that keeps the
   intro and then is not one at all. A leading line that is just the song and the artist, or a
   "Provided to YouTube by…"/"Lyrics:" banner, is dropped before anything is measured, so `first`
   means the first LYRIC — the thing the intro test is about — and the panel never opens on a
   credit. Only the first few seconds are inspected: a dash inside a real lyric is left alone. */
function stripCredits(lines, q){
  const title = String((q && q.title) || '');
  return lines.filter(l => {
    if (l.t > 5) return true;
    const s = l.text;
    if (/^(provided to youtube|lyrics\s*:|song\s*:|auto-generated)/i.test(s)) return false;
    const sep = /^.{0,90}\s[-\u2013\u2014|\u00b7\u2022]\s.{0,90}$/.test(s);
    /* "Zaalima - Arijit Singh/Harshdeep Kaur" scores only 0.2 against the bare title (the artist
       words dominate the set), so the test is on the part BEFORE the dash: a line that opens with
       the song's own name is a credit, whatever is written after it. */
    if (sep){
      const head = s.split(/\s[-\u2013\u2014|]\s/)[0];
      if (jaccard(head, title) >= 0.85 || jaccard(s, title) >= 0.3) return false;
    }
    return true;
  });
}
/* one candidate, in the shape /api/lyrics publishes. null when there is nothing to highlight. */
function packLines(source, lines, dur, q){
  lines = stripCredits((lines || []).slice(), q).sort((a, b) => a.t - b.t);
  if (!lines || lines.length < 2) return null;
  return {
    source,
    n: lines.length,
    dur: dur || 0,
    first: lines[0].t,
    synced: lines.map(l => '[' + lrcClock(l.t) + '] ' + l.text).join('\n'),
    plain: sanitizePlain(lines.map(l => l.text).join('\n'))
  };
}
/* ---- adapter: Better Lyrics (api.betterlyrics.org) --------------------------------------------
   The public endpoint is a CACHE, not a search: a keyless request is only answered when all four
   lookup parameters match an entry someone already asked for — s (title), a (artist), al (album)
   and d (length in WHOLE SECONDS). Anything else is 401 "Uncached queries require a valid API
   key", which is a MISS and nothing more.
   MEASURED, and it matters: al is part of that cache key, so `al=<the track title>` (the old
   fallback here) turned every album-less track into a guaranteed 401 — this adapter never once
   returned lyrics in production. Unknown album is sent as an EMPTY al, which is the shape the
   cache was filled with; d is rounded (`Math.round`), and a 1 s difference still hits. No duration
   means no request at all: the pool is asked before the audio element knows its length, and a
   request without d can only ever miss (and would be cached as that miss upstream). */
async function syncedBetterLyrics(q){
  if (!q.title) return null;
  const dur = Math.round(Number(q.duration) || 0);
  if (!(dur > 0)) return null;
  /* The artist is part of the key too, and our search rows credit everyone ('Arijit Singh,
     Harshdeep Kaur') where the cache was filled with the lead act alone. A 401 is cheap and
     comes back in milliseconds, so the credit string is tried first and the LEAD artist second —
     measured: Zaalima's joined credit misses, 'Arijit Singh' hits the same entry. */
  const full = String(q.artist || '');
  const lead = full.split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bx\b)\s*/i)[0].trim();
  const artists = (lead && lead !== full) ? [full, lead] : [full];
  let j = null;
  for (const a of artists) {
    const p = new URLSearchParams({ s: q.title, a, al: q.album || '', d: String(dur) });
    try {
      const r = await fetchT('https://api.betterlyrics.org/getLyrics?' + p,
        { headers: { 'User-Agent': LYR_UA } }, 5000);
      if (r.status === 401) {                   /* cache miss — the normal answer, not an error */
        if (process.env.LYR_DEBUG) console.log('betterlyrics: 401 cache miss for', p.toString());
        continue;
      }
      if (!r.ok) continue;
      const body = await r.json();
      if (body && body.ttml) { j = body; break }
    } catch (e) { /* deadline or bad JSON: try the next credit string, never throw */ }
  }
  if (!j) return null;
  const t = ttmlLines(j.ttml);
  if (q.duration > 0 && t.dur > 0 && Math.abs(t.dur - q.duration) > SYNC_DUR_TOL) return null;
  return packLines('betterlyrics', t.lines, t.dur, q);
}
/* ---- adapter: LyricsPlus (lyricsplus.prjktla.my.id) ---- */
async function syncedLyricsPlus(q){
  if (!q.title) return null;
  const p = new URLSearchParams({ title: q.title, artist: q.artist || '' });
  if (q.album) p.set('album', q.album);
  if (q.duration > 0) p.set('duration', String(Math.round(q.duration)));
  let j;
  try {
    const r = await fetchT('https://lyricsplus.prjktla.my.id/v2/lyrics/get?' + p,
      { headers: { 'User-Agent': LYR_UA, 'X-Client-Package': 'Svara <https://github.com/Shubham0743X/Svara>' } }, 6500);
    if (!r.ok) return null;
    j = await r.json();
  } catch (e) { return null }
  const t = kpoeLines(j);
  if (q.duration > 0 && t.dur > 0 && Math.abs(t.dur - q.duration) > SYNC_DUR_TOL) return null;
  return packLines('lyricsplus', t.lines, t.dur, q);
}
/* Resolve a track through the pool. Returns { best, lr }: `best` is a packed timed candidate (or
   null) and `lr` is the raw LRClib row, whose WORDS are the plain-text fallback even when its
   timings were refused. */
/* A resolved pool answer is reused for a while: the client asks twice per track (before and after
   the audio's length is known) and again on every pill switch, and each cold answer can cost a
   handful of upstream round-trips. Keyed by the request, bounded, and versioned so a build that
   changes what the pool means never serves the old shape. */
const POOL_V = '36a';
const POOL_CACHE = new Map();
function poolKey(q){
  return [POOL_V, q.title || '', q.artist || '', q.album || '', Math.round(q.duration || 0)].join('|').toLowerCase();
}
function poolGet(k){
  const e = POOL_CACHE.get(k);
  if (!e) return undefined;
  if (Date.now() - e.at > 15 * 60 * 1000) { POOL_CACHE.delete(k); return undefined }
  return e.v;
}
function poolPut(k, v){
  POOL_CACHE.set(k, { at: Date.now(), v });
  while (POOL_CACHE.size > 120) POOL_CACHE.delete(POOL_CACHE.keys().next().value);
}
async function syncedPool(q){
  const key = poolKey(q), memo = poolGet(key);
  if (memo) return memo;
  const lr = await lrclibBest(q);
  let best = null;
  if (lr && lr.syncedLyrics && !lr._durMismatch) {
    const f = normalizeLrc(lr.syncedLyrics);
    const lines = stripCredits(f.lines.slice(), q);
    if (lines.length >= 2) {
      best = { source: 'lrclib', n: lines.length, dur: lr.duration || 0, first: lines[0].t,
               synced: lines.map(l => '[' + lrcClock(l.t) + '] ' + l.text).join('\n'),
               plain: sanitizePlain(lr.plainLyrics || f.lrc) };
    }
  }
  /* the intro is there: first verified result wins, and nothing else is even asked */
  if (best && best.first <= SYNC_LATE) return { best, lr };
  /* missing / untimed / starts late — ask the other two. They are fetched TOGETHER (the panel is
     waiting and neither can answer without the other's network time) but chosen in preference
     order, so Better Lyrics still wins a tie and LyricsPlus is only the last word. */
  const [bl, lp] = await Promise.all([syncedBetterLyrics(q), syncedLyricsPlus(q)]);
  for (const c of [bl, lp]) {
    if (!c) continue;
    if (!best || c.first < best.first - 3) best = c;
    if (best.first <= SYNC_LATE) break;
  }
  const out = { best, lr };
  poolPut(key, out);
  return out;
}

// provider=auto (default) | ytm | lrclib
app.get('/api/lyrics', async (req, res) => {
  cacheHeaders(res, '/api/lyrics');
  const want = ['ytm', 'lrclib'].includes(req.query.provider) ? req.query.provider : 'auto';
  const id = String(req.query.id || '');
  const title = String(req.query.title || '');
  const artist = String(req.query.artist || '');
  const album = String(req.query.album || '');
  const duration = parseFloat(req.query.duration) || 0;
  const out = { provider: '', plain: '', synced: '', hasSync: false, note: '', error: '' };
  try {
    /* WAVE 35: the YouTube Music pill never consults the pool (it is plain text by definition). */
    const pool = (want === 'ytm') ? { best: null, lr: null } : await syncedPool({ title, artist, album, duration });
    const cand = pool.best;
    const lr = pool.lr;

    // 1) a TIMED file from the pool — the only ones that can be highlighted. WAVE 19: an LRClib
    //    match that failed its length / coverage tests is not one of them (its words are the right
    //    song's, its clock is another recording's); its text is published in branch 3 instead.
    if (want !== 'ytm' && cand) {
      out.provider = cand.source;
      out.synced = cand.synced;
      out.plain = cand.plain;
      out.hasSync = true;
      return res.json(out);
    }

    // 2) YouTube Music (curated, untimed). Under Auto it is the waterfall's answer when no provider
    //    had timings; on its own pill it is the requested answer. Either way it carries a note:
    //    what the user is looking at is not karaoke, and the pill that is one click away says so.
    if (want !== 'lrclib') {
      const ytText = await ytmLyrics(id);
      if (ytText) {
        out.provider = 'ytm';
        out.plain = sanitizePlain(ytText);
        out.note = want === 'ytm'
          ? 'YouTube Music lyrics are not time-synced — switch to LRCLIB for karaoke highlighting.'
          : 'No timed lyrics for this track — showing YouTube Music’s plain text.';
        return res.json(out);
      }
    }

    // 3) plain text as the last resort — LRClib's WORDS, never its refused clock
    if (lr && (lr.plainLyrics || lr.syncedLyrics)) {
      /* WAVE 19 — a match that failed lrclibBest's duration test keeps its WORDS and loses its
         timings: highlighting it would run this recording's clock on another recording's words.
         WAVE 35 — anything arriving here has no timed candidate from ANY of the three. */
      const mismatch = !!lr._durMismatch;
      out.provider = 'lrclib';
      out.synced = '';
      out.plain = sanitizePlain(lr.plainLyrics || lr.syncedLyrics || '');
      out.hasSync = false;
      if (mismatch) {
        const was = clock(lr._durOf), is = clock(duration), to = clock(lr._spanTo);
        /* which test sent it down here decides what the note says — a recording of a different
           LENGTH, or timings that only cover a shorter CUT of the song. */
        const lenOff = was && is
          && Math.abs((lr._durOf || 0) - duration) > Math.max(30, Math.round(duration * 0.25));
        out.note = lenOff
          ? 'These words are from the ' + was + ' version of this song — LRClib has nothing timed for this '
            + is + ' one, so the lines are not highlighted.'
          : (to && is)
            ? 'LRClib\u2019s timed lyrics for this song stop at ' + to + ' while this track runs ' + is
              + ' — they were written for a shorter cut, so they are shown without highlighting.'
            : 'These words are from another version of this song — LRClib has no timed lyrics that match this one, so the lines are not highlighted.';
      }
      else out.note = 'No timed lyrics found for this track — showing plain text.';
      return res.json(out);
    }

    out.error = 'No lyrics found for this track';
    res.json(out);
  } catch (e) {
    out.error = String(e.message || e);
    res.json(out);
  }
});

/* ================= download (bug #3: stop guessing the path) ================= */
function safeName(s, fallback){
  const out = String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')   // Windows-illegal characters
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    /* Windows silently strips trailing dots/spaces from a filename, so "Song ." would be saved
       as "Song" while the header promises "Song .m4a" — trim them here so both agree. */
    .replace(/[. ]+$/, '');
  return out || fallback;
}
async function runYtdlp(args, timeout){
  try {
    const r = await execFileP(YTDLP, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '', message: String(e.message || e) };
  }
}
function pickAudioFile(dir){
  const files = fs.readdirSync(dir).filter(f => /\.(m4a|webm|opus|mp3|ogg|oga|wav|aac|flac)$/i.test(f));
  if (!files.length) return null;
  return path.join(dir, files.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0]);
}
/* A download runs yt-dlp (up to two 420s attempts) in its own temp dir, so a burst of clicks
   must not spawn a process each. Two at a time is plenty for a single-user app; the rest are
   told to wait rather than piling up. */
const DOWNLOAD_MAX = 2;
let downloadsActive = 0;
app.get('/api/download', async (req, res) => {
  noStore(res);                     // 4AK: a downloaded file is never cached by the proxy
  const id = String(req.query.id || '');
  if (!id || !/^[\w-]{6,}$/.test(id)) return res.status(400).json({ error: 'bad id' });
  if (downloadsActive >= DOWNLOAD_MAX) return res.status(429).json({ error: 'A download is already running — try again in a moment' });
  downloadsActive++;
  let released = false;
  const release = () => { if (!released) { released = true; downloadsActive--; } };
  res.on('close', release);         // also covers an aborted download / a streamed file
  const wantTitle = String(req.query.title || '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-'));
  const url = 'https://www.youtube.com/watch?v=' + id;
  const base = [
    '-f', 'bestaudio/bestaudio*/best',
    '--no-playlist', '--no-progress',
    '--retries', '5', '--fragment-retries', '5', '--file-access-retries', '3',
    '-o', path.join(dir, 'svara-audio.%(ext)s'),
    url
  ];
  try {
    let run = await runYtdlp(base, 420000);
    let file = pickAudioFile(dir);
    // one retry with a different YouTube client — covers format/403/bot-check cases
    if (!file) {
      fs.readdirSync(dir).forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} });
      const retry = base.slice(0, base.length - 1).concat([
        '--extractor-args', 'youtube:player_client=default,web_safari', url
      ]);
      run = await runYtdlp(retry, 420000);
      file = pickAudioFile(dir);
    }
    if (!file) {
      const why = (run.stderr || run.message || '').split('\n')
        .filter(l => /error|unavailable|sign in|403|not available|private|age/i.test(l))
        .slice(-2).join(' • ').trim();
      throw new Error(why || 'yt-dlp produced no audio file');
    }
    const ext = path.extname(file);
    const nice = safeName(wantTitle || path.basename(file, ext), 'track') + ext;
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
    res.download(file, nice, (err) => { cleanup(); if (err && !res.headersSent) res.status(500).json({ error: String(err.message || err) }); });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) {}
    console.error('download error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
  }
});

/* ================= thumbnail proxy (album-art theming) ================= */
/* the artwork hosts this proxy will talk to — used for the requested URL AND for the URL a
   redirect actually landed on (following redirects unchecked is a host-allowlist bypass). */
function thumbHostAllowed(u){
  const host = u.hostname;
  return u.protocol === 'https:' && (
    host === 'i.ytimg.com' || host.endsWith('.ytimg.com') ||
    host === 'yt3.googleusercontent.com' || host.endsWith('.googleusercontent.com') ||
    host.endsWith('.ggpht.com')
  );
}
const THUMB_MAX = 12 * 1024 * 1024;      // album art is ~100KB; a 12MB ceiling is only a guard
app.get('/api/thumb', async (req, res) => {
  try {
    const u = new URL(String(req.query.url || ''));
    if (!thumbHostAllowed(u)) return res.status(400).json({ error: 'blocked host' });
    const host = u.hostname;
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    let r = await fetchHead(u, { headers: { 'User-Agent': UA } }, 15000);
    /* 4AG — one bounded retry, and only for the recoverable case. Measured live: the artwork host
       answers a burst of concurrent asks for the SAME url with `429 text/html` (24/60 at 60-way
       concurrency) and sends NO Retry-After header; the very same url returns `200 image/jpeg` on
       the next ask — 8/8 captured 429s converted after ~900ms. So ONE delayed retry turns the
       throttle back into artwork instead of an error. A 400/404 is deterministic, so it is reported
       straight away and never retried. No loop: exactly one extra fetch. */
    if (r.status === 429) {
      const ra = parseInt(r.headers.get('retry-after'), 10);   // absent in the field; honour it if sent
      await new Promise(s => setTimeout(s, ra > 0 ? Math.min(ra * 1000, 3000) : 900));
      r = await fetchHead(u, { headers: { 'User-Agent': UA } }, 15000);
    }
    if (!r.ok) {
      /* 4AG: never an empty 502 again — carry the upstream status so a failed artwork request is
         diagnosable, and keep an upstream Retry-After when the host sent one. Success responses are
         byte-identical to before (5/5 sha1 match vs the direct host). */
      const ra2 = r.headers.get('retry-after');
      if (ra2) res.setHeader('Retry-After', ra2);
      console.error('thumb: upstream ' + r.status + ' for ' + host);
      return res.status(502).json({ error: 'upstream ' + r.status });
    }
    /* the allow-list above vetted the URL WE asked for; redirects are followed, so check where
       the request actually landed before a byte of it is forwarded. */
    let landed = null;
    try { landed = new URL(r.url) } catch (e) { landed = null; }
    if (!landed || !thumbHostAllowed(landed)) {
      try { if (r.body) r.body.cancel() } catch (e) {}
      return res.status(400).json({ error: 'blocked host' });
    }
    const len = parseInt(r.headers.get('content-length') || '0', 10);
    if (len > THUMB_MAX) {
      try { if (r.body) r.body.cancel() } catch (e) {}
      return res.status(502).json({ error: 'upstream too large' });
    }
    res.status(200);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    const body = Readable.fromWeb(r.body);
    let sent = 0;
    body.on('data', chunk => {
      sent += chunk.length;
      if (sent > THUMB_MAX) { try { body.destroy(); } catch (e) {} try { res.destroy(); } catch (e) {} }
    });
    body.on('error', () => res.destroy());
    /* a client that goes away (or a capped body) must not leave the upstream download running */
    res.on('close', () => { try { body.destroy(); } catch (e) {} });
    body.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ error: String(e.message || e) }); else res.destroy();
  }
});

/* ================= stream ================= */
const streamCache = new Map();
const STREAM_TTL = 3 * 60 * 60 * 1000;   // a signed googlevideo URL lives ~6h; 3h is a safe window
const STREAM_CACHE_MAX = 80;             // bounded: the oldest entry is dropped, not the whole map
const streamResolving = new Map();       // videoId → the in-flight resolve, shared by every caller
/* Wave 5 (UI-5) — MEASURED cold vs warm: resolving a stream URL costs 3.6-4.5 s (yt-dlp process +
   YouTube extraction) while the SAME id answers in 0.07-0.15 s out of this cache. That resolution
   was the entire "a song takes ages to start" delay — the audio itself was already streamed
   progressively (Range/206, piped straight through). So the URL is now resolved AHEAD of playback
   by /api/prefetch, and this function deduplicates: a prefetch that overlaps real playback must
   never spawn a second yt-dlp process for the same video. */
/* WAVE 28 — `variant` 1 re-extracts with the download route's fallback pairing (default,web_safari).
   MEASURED 2026-10-19 (yt-dlp 2026.08.19), so the comment tells the truth: web_safari alone answers
   "Only images are available" for audio (it needs a GVS PO token), and web_embedded/tv/mweb resolve
   a URL that goes on to 403, so neither can be used as a stand-in client. What the retry really
   buys is a SECOND EXTRACTION — a freshly signed URL (new expire/ei/sig, often a different
   googlevideo host) — which is what clears the burst 403s seen in the field. The stream route still
   drops the dead entry before asking, so this can never hand back the URL that just failed. */
async function resolveStreamUrl(videoId, variant){
  const args = ['-f', 'ba', '-g'];
  if (variant) args.push('--extractor-args', 'youtube:player_client=default,web_safari');
  args.push('https://www.youtube.com/watch?v=' + videoId);
  const { stdout } = await execFileP(YTDLP, args, { timeout: 60000, windowsHide: true });
  const url = (stdout || '').trim().split('\n').pop();
  if (!url) throw new Error('yt-dlp returned no URL for ' + videoId);
  if (streamCache.size >= STREAM_CACHE_MAX) {
    const oldest = streamCache.keys().next().value;
    if (oldest !== undefined && oldest !== videoId) streamCache.delete(oldest);
  }
  /* delete first: set() on an EXISTING key keeps its old position, so a refreshed URL would
     otherwise stay at the front of the Map and be the next one evicted. */
  streamCache.delete(videoId);
  streamCache.set(videoId, { url, expires: Date.now() + STREAM_TTL });
  return url;
}
function getStreamUrl(videoId, variant){
  const hit = streamCache.get(videoId);
  if (hit && hit.expires > Date.now()) {
    /* LRU touch — same reason as above: reading an entry must move it to the back, or a hot
       track can be evicted while a cold one sits in front of it. */
    streamCache.delete(videoId);
    streamCache.set(videoId, hit);
    return Promise.resolve(hit.url);
  }
  const key = videoId + '#' + (variant ? 1 : 0);          // the two clients resolve independently
  const inflight = streamResolving.get(key);
  if (inflight) return inflight;
  const guarded = resolveStreamUrl(videoId, variant).then(
    url => { streamResolving.delete(key); return url },
    err => { streamResolving.delete(key); throw err }
  );
  streamResolving.set(key, guarded);
  return guarded;
}

/* ---------- Wave 5 (UI-5): warm the URL before playback needs it ----------
   The player asks for the tracks that are NEXT in the play order the moment a track starts, so by
   the time the song ends its URL is signed and cached and playback starts in ~0.1 s instead of
   ~4 s. Deliberately SERIAL and bounded — sliding the cursor across a list must never spawn one
   yt-dlp per row. Duplicates collapse (a cache hit is not queued, the same id is queued once). */
const warmQueue = [];
const warmPending = new Set();
let warmBusy = false;
const WARM_MAX = 8;                      // at most this many un-started warm-ups at any moment
/* MEASURED: a cold /api/stream hit `upstream 403` for a freshly resolved URL and the route's own
   retry (refresh the URL, fetch again) cost a SECOND ~4 s yt-dlp run, i.e. an 8.5 s start. YouTube
   is simply not deterministic here — the next resolve works. So the prefetch VERIFIES the URL it
   just resolved with the same 2-byte Range request the player would send, and if that answers
   403/410 it re-resolves immediately. The recovery then happens while the previous song is still
   playing instead of in front of the listener. The stream route keeps its own retry as the net. */
async function verifyWarmUrl(id){
  const url = await getStreamUrl(id);
  let up;
  try {
    up = await fetchHead(url, { headers: { Range: 'bytes=0-1', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, 15000);
  } catch (e) {
    console.error(`prefetch: ${id} probe failed (${e.message}) — re-resolving`);
    streamCache.delete(id);
    return getStreamUrl(id);
  }
  if (up.ok) { try { if (up.body) up.body.cancel(); } catch (e) { /* nothing to drain */ } return url };
  console.error(`prefetch: warmed URL for ${id} answered ${up.status} — re-resolving once`);
  try { if (up.body) up.body.cancel(); } catch (e) { /* nothing to drain */ }
  streamCache.delete(id);
  return getStreamUrl(id);
}
function pumpWarm(){
  if (warmBusy) return;
  const id = warmQueue.shift();
  if (!id) return;
  warmBusy = true;
  const t0 = Date.now();
  verifyWarmUrl(id).then(
    () => console.log(`prefetch: ${id} warmed+verified in ${Date.now() - t0}ms`),
    e => console.error('prefetch failed for', id, '-', e.message)
  ).then(() => { warmBusy = false; warmPending.delete(id); pumpWarm(); });
}
function warmStream(id){
  id = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return false;      // only something that looks like a video id
  if (warmPending.has(id) || warmQueue.length >= WARM_MAX) return false;
  const hit = streamCache.get(id);
  if (hit && hit.expires > Date.now()) return false;        // already warm — nothing to do
  warmPending.add(id);
  warmQueue.push(id);
  pumpWarm();
  return true;
}
app.get('/api/prefetch', (req, res) => {
  noStore(res);
  const ids = String(req.query.ids || req.query.id || '').split(',').slice(0, 4);
  let queued = 0;
  ids.forEach(id => { if (warmStream(id)) queued++ });
  res.json({ queued });     // fire-and-forget: the client never waits on this answer
});
app.get('/api/stream', async (req, res) => {
  noStore(res);                     // 4AK: never cache audio; Range/seek is unaffected
  try {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).end();
    const range = req.headers.range || 'bytes=0-';
    /* googlevideo URLs are signed and expire on their own schedule, separately from our 3h
       cache entry. A dead URL answers 403/410, so drop the stale entry, resolve a fresh URL
       ONCE and retry the upstream fetch ONCE. No loop; the retry's failure carries a reason. */
    const hostOf = u => { try { return new URL(u).host; } catch (e) { return 'unknown'; } };
    /* handshake-only deadline: the body is the song, so it must not be aborted on a timer */
    const grab = u => fetchHead(u, { headers: { Range: range, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, 20000);
    let url = await getStreamUrl(id);
    let up = await grab(url);
    if (!up.ok) {
      console.error(`stream: upstream ${up.status} for ${id} (host ${hostOf(url)}) — refreshing URL and retrying once`);
      streamCache.delete(id);
      /* WAVE 28: wait out the blip, then re-extract (see resolveStreamUrl — the retry's value is a
         fresh signature, not a different client). Only if that resolve itself fails does it fall
         back to the default one. One extra attempt in total, no loop; the renderer owns the rest
         (v28js retries twice more, 700 ms and 1.8 s later). */
      await new Promise(s => setTimeout(s, 250));
      let fresh = url;
      try { fresh = await getStreamUrl(id, 1) }
      catch(e){ try { fresh = await getStreamUrl(id, 0) } catch(e2){} }
      url = fresh;
      up = await grab(url);
      if (!up.ok) {
        /* the failing URL must not stay cached: the renderer's own retry (v28js) re-requests this
           route a second later expecting a fresh resolve, and a cached 403-ing URL would just
           repeat itself. */
        streamCache.delete(id);
        console.error(`stream: upstream ${up.status} again for ${id} (host ${hostOf(url)}) — giving up`);
        return res.status(502).json({ error: `upstream ${up.status} after refreshing the stream URL` });
      }
    }
    res.status(up.status);
    const map = { 'content-type': 'Content-Type', 'content-length': 'Content-Length', 'content-range': 'Content-Range', 'accept-ranges': 'Accept-Ranges' };
    for (const [k, v] of Object.entries(map)) {
      const hv = up.headers.get(k);
      if (hv) res.setHeader(v, hv);
    }
    const body = Readable.fromWeb(up.body);
    body.on('error', () => res.destroy());
    /* the renderer aborts a seek by dropping the response — without this the upstream
       download (and the socket) keeps going for the rest of the song. */
    res.on('close', () => { try { body.destroy(); } catch (e) {} });
    body.pipe(res);
  } catch (e) {
    console.error('stream error:', e.message);
    const reason = String(e.message || e).split('\n').map(s => s.trim()).filter(Boolean).pop();
    if (!res.headersSent) res.status(500).json({ error: reason || 'stream failed' }); else res.destroy();
  }
});

/* ================= system info (read-only, for the settings panel) ================= */
app.get('/api/system', (req, res) => {
  let version = '';
  try { version = require('./package.json').version || ''; } catch (e) { version = ''; }
  res.json({ version, ytdlp: YTDLP, ytdlpFound: fs.existsSync(YTDLP) });
});

/* ================= fonts (Wave 4BG — read-only, files live in ./fonts) ================= */
const FONT_DIR = path.join(__dirname, 'fonts');
const FONT_MIME = { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
app.get('/fonts/:file', (req, res) => {
  const name = String(req.params.file || '');
  const ext = path.extname(name).toLowerCase();
  if (!FONT_MIME[ext] || !/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) return res.status(404).end();
  const full = path.join(FONT_DIR, name);
  if (!full.startsWith(FONT_DIR + path.sep)) return res.status(404).end();
  let st; try { st = fs.statSync(full); } catch (e) { return res.status(404).end(); }
  if (!st.isFile()) return res.status(404).end();
  res.setHeader('Content-Type', FONT_MIME[ext]);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(full);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const srv = app.listen(3000, '127.0.0.1', () => console.log('🎵 Svara → http://localhost:3000'));
// Wave 4AD: warm the memoised Innertube client ONCE after the server is up. Measured:
// the very first /api/search on a cold process cost 3.9s vs 1.6s warm (~2.2s of client
// initialisation paid by whichever request happens to arrive first). This removes that
// one-off cold penalty without touching any route. A failure is deliberately ignored —
// the real request still calls getYt() and reports its own error.
getYt().catch(() => {});
srv.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('Port 3000 is busy — Svara is probably already running.');
  else console.error('Server error:', e.message);
});
