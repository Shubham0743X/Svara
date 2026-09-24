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

/* ================= helpers ================= */
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
    return {
      id: i.id,
      kind,
      label: withLabel ? rowLabel(i) : '',   // 4W-D2: the All list's own per-row type label
      title: isArtistRow ? (artName || txt(i.title)) : txt(i.title),
      artist: isArtistRow ? artName : extractArtist(i),
      artists: isArtistRow ? (i.id ? [{ name: artName, id: i.id }] : []) : artistList(i),
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
function mergeAllRows(base, groups){
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
  return out;
}

app.get('/api/search', async (req, res) => {
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
        items = mergeAllRows(items, [mapSearchRows(cats[0], 'song'), mapSearchRows(cats[1], 'album'), mapSearchRows(cats[2], 'artist')]);
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
function ytStill(id){ return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg'; }

app.get('/api/radio', async (req, res) => {
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
          items.push({
            id: vid,
            kind: 'track',
            title: txt(it.title),
            artist: byline(it),
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
app.get('/api/artist', async (req, res) => {
  const wantId = String(req.query.id || '').trim();
  const wantName = String(req.query.name || '').trim();
  if (!wantId && !wantName) return res.json({ id: null, error: 'missing id or name' });
  try {
    const youtube = await getYt();

    // name → browseId: ONE artist search, exact-name first. Failure ⇒ { id: null }.
    let id = wantId;
    if (!id) {
      const s = await youtube.music.search(wantName, { type: 'artist' });
      const rows = collectItems(s.contents || [], []).filter(r => r && r.id && String(r.id).startsWith('UC'));
      const nm = r => txt(r.name) || txt(r.title);
      // EXACT name only — never rows[0]. A fuzzy fallback silently opens an unrelated
      // artist (measured: "Study" → "Lofi Beat Study", "Dan" → "Dan Bull"), which is
      // exactly the wrong-identity page this route must not produce. Unknown ⇒ plain text.
      const norm = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
      const hit = rows.find(r => norm(nm(r)) === norm(wantName));
      id = (hit && hit.id) || '';
      if (!id) return res.json({ id: null });
    }
    if (!/^UC/.test(id) && !id.startsWith('FEmusic_library_privately_owned_artist')) {
      return res.json({ id: null, error: 'invalid artist id' });
    }

    // ONE browse: parsed for structure, raw for the fields 18.0.0's parser drops
    const raw = await youtube.actions.execute('/browse', { browseId: id, client: 'YTMUSIC' });
    const data = raw && raw.data;
    if (!data || data.header == null) return res.json({ id: null, error: 'artist not found' });
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

    const topShelf = shelves.find(s => s.title && s.title.text === 'Top songs') || shelves[0];
    const topSongs = topShelf ? (topShelf.contents || []).map(i => mapTrack(i, '', false)).filter(t => t && t.id) : [];

    // classify carousels by item type (language-independent): album → Albums & singles, artist → related
    const albums = [], related = [], seenAlbum = new Set();
    for (const c of carousels) {
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

    res.json({
      id,
      name: txt(header && header.title) || wantName,
      description: txt(header && header.description),
      monthlyAudience: txt(hdrRaw.monthlyListenerCount),
      banner: bestUrl(thumbSrc),
      thumb: bestUrl((header && header.foreground_thumbnail) || thumbSrc),
      topSongs,
      albums,
      related
    });
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
  const r = await fetch('https://lrclib.net/api/get?' + p, {
    headers: { 'User-Agent': 'Svara/2.0 (music player)' }
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}
async function lrSearch(params){
  const p = new URLSearchParams(params);
  const r = await fetch('https://lrclib.net/api/search?' + p, {
    headers: { 'User-Agent': 'Svara/2.0 (music player)' }
  });
  if (!r.ok) return [];
  try { const j = await r.json(); return Array.isArray(j) ? j : []; } catch (e) { return []; }
}
async function lrclibBest({ title, artist, album, duration }){
  if (!title) return null;
  const titles = titleVariants(title);
  const artists = artistVariants(artist);
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
    const aScore = Math.max(...artists.map(a => jaccard(a, row.artistName || '')));
    const dScore = duration > 0 && row.duration
      ? Math.max(0, 1 - Math.abs(row.duration - duration) / 12) : 0.5;
    let score = 0.5 * tScore + 0.3 * aScore + 0.2 * dScore;
    if (row._how.startsWith('exact')) score += 0.05;
    if (row.syncedLyrics) score += 0.06;                 // timed lyrics win near-ties
    ranked.push({ row, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 0.35) return null;
  // if the winner has no timings, prefer a slightly lower synced entry when it's still a match
  if (!best.row.syncedLyrics) {
    const timed = ranked.find(x => x.row.syncedLyrics && x.score >= best.score - 0.12);
    if (timed) return timed.row;
  }
  return best.row;
}

// provider=auto (default) | ytm | lrclib   → auto prefers SYNCED lyrics
app.get('/api/lyrics', async (req, res) => {
  const want = ['ytm', 'lrclib'].includes(req.query.provider) ? req.query.provider : 'auto';
  const id = String(req.query.id || '');
  const title = String(req.query.title || '');
  const artist = String(req.query.artist || '');
  const album = String(req.query.album || '');
  const duration = parseFloat(req.query.duration) || 0;
  const out = { provider: '', plain: '', synced: '', hasSync: false, note: '', error: '' };
  try {
    let lr = null, ytText = '';
    if (want !== 'ytm') lr = await lrclibBest({ title, artist, album, duration });

    // 1) timed LRClib lyrics win — the only ones we can highlight
    if (want !== 'ytm' && lr && lr.syncedLyrics) {
      out.provider = 'lrclib';
      out.synced = lr.syncedLyrics;
      out.plain = lr.plainLyrics || lr.syncedLyrics;
      out.hasSync = true;
      if (lr.trackName && jaccard(title, lr.trackName) >= 0.5) out.note = '';
      return res.json(out);
    }

    // 2) YouTube Music (curated, untimed)
    if (want !== 'lrclib') {
      ytText = await ytmLyrics(id);
      if (ytText) {
        out.provider = 'ytm';
        out.plain = ytText;
        out.note = 'YouTube Music lyrics are not time-synced — switch to LRClib for karaoke highlighting.';
        return res.json(out);
      }
    }

    // 3) LRClib plain lyrics as the last resort
    if (lr && (lr.plainLyrics || lr.syncedLyrics)) {
      out.provider = 'lrclib';
      out.synced = lr.syncedLyrics || '';
      out.plain = lr.plainLyrics || lr.syncedLyrics || '';
      out.hasSync = !!lr.syncedLyrics;
      if (!out.hasSync) out.note = 'LRClib has no timed lyrics for this track — lines are not clickable.';
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
    .slice(0, 120);
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
app.get('/api/download', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id || !/^[\w-]{6,}$/.test(id)) return res.status(400).json({ error: 'bad id' });
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
app.get('/api/thumb', async (req, res) => {
  try {
    const u = new URL(String(req.query.url || ''));
    const host = u.hostname;
    const allowed = u.protocol === 'https:' && (
      host === 'i.ytimg.com' || host.endsWith('.ytimg.com') ||
      host === 'yt3.googleusercontent.com' || host.endsWith('.googleusercontent.com') ||
      host.endsWith('.ggpht.com')
    );
    if (!allowed) return res.status(400).json({ error: 'blocked host' });
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    if (!r.ok) return res.status(502).end();
    res.status(200);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

/* ================= stream ================= */
const streamCache = new Map();
async function getStreamUrl(videoId){
  const hit = streamCache.get(videoId);
  if (hit && hit.expires > Date.now()) return hit.url;
  const { stdout } = await execFileP(YTDLP, ['-f', 'ba', '-g', 'https://www.youtube.com/watch?v=' + videoId], { timeout: 60000, windowsHide: true });
  const url = (stdout || '').trim().split('\n').pop();
  if (!url) throw new Error('yt-dlp returned no URL for ' + videoId);
  streamCache.set(videoId, { url, expires: Date.now() + 3 * 60 * 60 * 1000 });
  return url;
}
app.get('/api/stream', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).end();
    const range = req.headers.range || 'bytes=0-';
    /* googlevideo URLs are signed and expire on their own schedule, separately from our 3h
       cache entry. A dead URL answers 403/410, so drop the stale entry, resolve a fresh URL
       ONCE and retry the upstream fetch ONCE. No loop; the retry's failure carries a reason. */
    const hostOf = u => { try { return new URL(u).host; } catch (e) { return 'unknown'; } };
    const grab = u => fetch(u, { headers: { Range: range, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    let url = await getStreamUrl(id);
    let up = await grab(url);
    if (!up.ok) {
      console.error(`stream: upstream ${up.status} for ${id} (host ${hostOf(url)}) — refreshing URL and retrying once`);
      streamCache.delete(id);
      url = await getStreamUrl(id);
      up = await grab(url);
      if (!up.ok) {
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
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
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
