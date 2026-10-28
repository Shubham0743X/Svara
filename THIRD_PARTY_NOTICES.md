# Third-Party Notices

Svara's own source code is licensed under the MIT License (see `LICENSE`).
The MIT License does **not** apply to the third-party materials listed below,
which remain the property of their respective owners and are subject to their
own terms.

## Fonts

The font files in the `fonts/` directory are third-party software.
© 2021, Copyright by Lineto. All rights reserved. See `fonts/COPYRIGHT.txt`.

They are used within Svara for its user interface only. No right to copy,
modify or redistribute these fonts separately from Svara is granted by the
MIT License or by this repository. To use them elsewhere, obtain a license
from the copyright holder.

## Open-source software

Svara is built with, and its releases include, the following software, each
under its own license. Full license texts are available in each project's
repository and in the installed `node_modules` packages.

| Component | Use in Svara | License |
| --- | --- | --- |
| Electron | Desktop application shell | MIT |
| Express | Local web server | MIT |
| youtubei.js | YouTube Music client library | MIT |
| yt-dlp | Resolving audio streams for playback and downloads (bundled as `yt-dlp.exe` in releases) | Project source: Unlicense. The bundled `yt-dlp.exe` is an official PyInstaller build that includes GPLv3+ code, so that executable is distributed under **GPLv3+** |

`yt-dlp.exe` is redistributed unmodified, exactly as published by the yt-dlp
project (version 2026.08.19 in the 1.3.0 release). Its own notices, including
the full list of components inside the executable, are in
[`THIRD_PARTY_LICENSES.txt`](https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt);
the GPLv3 text is at <https://www.gnu.org/licenses/gpl-3.0.html>, and the
corresponding source is at <https://github.com/yt-dlp/yt-dlp>. Electron itself
bundles Chromium and Node.js, whose notices ship with the Electron distribution
in the installed app.

## Lyrics services

Synced and plain lyrics are fetched from third-party services (including
LRCLIB, BetterLyrics and LyricsPlus). Lyrics remain the property of their
respective rights holders; Svara does not store or redistribute them.

## Trademarks and content

YouTube and YouTube Music are trademarks of Google LLC. Svara is an
independent project and is not affiliated with, endorsed by or sponsored by
YouTube or Google. Audio, artwork and metadata are provided by YouTube and
remain the property of their respective owners. Use of downloaded content is
the user's responsibility under YouTube's Terms of Service.
