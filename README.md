<p align="center">
  <img src="icons/icon128.png" width="72" alt="Sift">
</p>

<h1 align="center">Sift</h1>

<p align="center">Filter your X For You feed by country, words and accounts.</p>

<p align="center">
  <img src="store/screenshot-1-countries.png" width="760" alt="Sift popup showing country rules">
</p>

## Features

- **Country filtering.** X shows where an account is based in its *About this account* panel. Sift reads that for each author in your feed. Then it either hides or blocks posts from the countries and regions you pick, or shows only the ones you allow.
- **Flags on posts.** A small flag next to each post's timestamp. It renders properly on Windows too.
- **Word rules.** Words, phrases or `/regex/`. Matching is whole-word, so `crypto` won't catch "cryptography".
- **Account rules.** Hide, block or always allow specific accounts. You can also right-click any profile link on X.
- **Hide or block.** Any rule can just hide posts, or block the author on X for you. Auto-block is off until you turn it on.
- **Clean up.** Drop promoted posts, "Who to follow", verified accounts and reposts.
- **Collapse or remove.** Filtered posts either collapse to a slim bar with **Show** and **Block** buttons, or disappear completely.
- Only touches the **For You** tab by default. Rules can be imported and exported as JSON.

## Install

**Chrome Web Store:** *coming soon*

**From source** (Chrome, Edge, Brave, any Chromium browser 111+):

1. Download this repo (Code → Download ZIP) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder that contains `manifest.json`.

## How country lookups work

- Sift calls the same endpoint x.com uses for *About this account* (`AboutAccountQuery`), using your existing logged-in session. It doesn't use any other service.
- Results are cached on your device for 30 days. Accounts with no location are cached for 1 day.
- Lookups run two at a time, newest posts first, and pace themselves using X's rate-limit headers. If X rate-limits you, posts that are already cached keep filtering, and the popup shows when lookups will resume.
- **Wait for location** holds a post for up to 5 seconds while its author's country loads, so filtered posts never flash onto your screen. If a lookup is slow or fails, the post is shown.
- When X changes the query ID, Sift picks up the new one the next time X itself loads an *About this account* panel.

## Privacy

Everything stays in your browser. Sift has no server, no analytics and no tracking. See [PRIVACY.md](PRIVACY.md).

## Building a store package

```powershell
./build.ps1          # Windows → dist/sift-<version>.zip
```
```bash
./build.sh           # macOS / Linux
```

## Credits

- Flag glyphs come from [Twemoji](https://github.com/twitter/twemoji) (CC-BY 4.0), packaged as a font by [country-flag-emoji-polyfill](https://github.com/talkjs/country-flag-emoji-polyfill) (MIT).

Sift isn't affiliated with or endorsed by X Corp.

## License

MIT © RamenNuudls
