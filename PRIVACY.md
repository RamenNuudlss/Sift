# Sift Privacy Policy

_Last updated: November 17, 2026_

Sift is a browser extension that filters posts on x.com. It doesn't collect, sell or share any of your data.

## What Sift stores

Everything below is kept only in your browser's local extension storage, on your device:

- Your rules: the countries, words and accounts you add, plus your settings.
- Filtering counts: how many posts were filtered, and how many accounts were blocked.
- A location cache that maps account handles to a country or region. It holds either what X reports for the account (expires after 30 days) or a country matched from their public profile location (expires after 7 days).
- A list of accounts Sift has blocked for you, so it doesn't block the same account twice.

You can clear the location cache and the stats from the popup at any time. Uninstalling Sift deletes everything.

## Reading X's responses

To show locations without spending X's small lookup budget, Sift reads a copy of the data x.com already loads in your browser (feeds, replies and profiles), and takes each author's handle and profile location from it. This happens entirely on your device. X's requests and responses are passed through unchanged, and nothing is stored except the resulting country per handle.

## Network requests

Sift talks only to **x.com / twitter.com**, using the session you're already signed in with. It makes two kinds of requests:

- It looks up an account's *Account based in* location, the same information X shows in a profile's *About this account* panel.
- It blocks an account, but only when you click **Block** or have turned on **Auto-block** for a matching rule.

Sift has no server. Nothing is sent to the developer or to any third party. There is no analytics, tracking or advertising.

## Permissions

- **storage**: saves your rules, stats and location cache on your device.
- **contextMenus**: adds "Sift: hide this account" and "Sift: always show this account" to the right-click menu on X profile links.
- **Access to x.com and twitter.com**: lets Sift read the timeline so it can filter it, and make the requests described above.

## Contact

Questions? Open an issue at https://github.com/RamenNuudlss/Sift/issues.
