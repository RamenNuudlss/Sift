# Chrome Web Store submission

Copy each field below into the Developer Dashboard (https://chrome.google.com/webstore/devconsole).

## Package
Upload `dist/sift-1.0.0.zip` (create it with `build.ps1`).

## Store listing

**Name** (taken from the manifest): Sift — Country & Keyword Filter for X

**Summary** (max 132 characters):
Filter your X For You feed by country, continent, words and accounts. Hide posts or auto-block the accounts behind them.

**Category:** Social & Communication
**Language:** English

**Description:**
```
Sift cleans up your X (Twitter) For You feed.

FILTER BY COUNTRY OR CONTINENT
X shows where an account is based in its "About this account" panel. Sift reads that for each author in your feed. Then it either hides posts from the countries, regions or whole continents you pick, or shows only the ones you allow. A small flag next to each post shows where it's from.

FILTER BY WORDS AND ACCOUNTS
• Words, phrases or /regex/, with whole-word matching
• Hide, block or always allow specific accounts
• Right-click any profile link to hide or allow that account

HIDE OR BLOCK
Each rule can just hide posts, or block the author on X for you. Auto-block is off by default and capped at 100 accounts a day.

CLEAN UP
Remove promoted posts, "Who to follow", verified accounts and reposts.

STAYS OUT OF THE WAY
• Only touches the For You tab by default
• Filtered posts collapse to a slim bar you can reopen, or disappear completely
• Can hold a post for a moment while its author's location loads, so filtered posts never flash in
• Import and export your rules

PRIVATE
Everything stays on your device. Sift has no server, no analytics and no tracking. It talks only to x.com, using the session you're already signed in with.

Open source: https://github.com/RamenNuudlss/Sift
Not affiliated with X Corp.
```

**Screenshots** (1280×800): `store/screenshot-1-countries.png` … `screenshot-4-options.png`
**Small promo tile** (440×280): `store/promo-tile-440x280.png`
**Store icon** (128×128): `icons/icon128.png`

**Homepage URL:** https://github.com/RamenNuudlss/Sift
**Support URL:** https://github.com/RamenNuudlss/Sift/issues

## Privacy practices tab

**Single purpose:**
```
Filters posts on the X (Twitter) home timeline based on the user's own rules: the account's country or continent, words in the post, and specific accounts.
```

**Permission justifications:**

- **storage:**
  `Saves the user's filter rules, settings, filter counts and a local cache of account locations on the device.`
- **contextMenus:**
  `Adds "Sift: hide this account" and "Sift: always show this account" to the right-click menu on X profile links.`
- **Host permission (x.com, twitter.com):**
  `Needed to read and filter posts on the X timeline, and to call X's own endpoints, using the user's existing session, to look up an account's "Account based in" location and to block accounts when the user asks.`

**Remote code:** No, I am not using remote code.

**Data usage:** don't tick any of the data types. Sift doesn't collect or transmit user data off the device, except requests the user's own session makes to x.com. Tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/RamenNuudlss/Sift/blob/main/PRIVACY.md

## Distribution
Visibility: Public · Regions: All regions
