# Lot Suggestion Tool

A personal Progressive Web App. Photograph a batch of items (CDs, records, matchbooks, sewing patterns, etc.) and Claude suggests logical, themed groupings for sale as eBay lots.

No build step. No Node.js required. Just static files hosted on GitHub Pages.

## How it works

1. You paste your Anthropic API key once (stored only in your phone's browser).
2. You take photos of the items in a batch.
3. You tell the app how many lots you want, with an optional "fuzzy" flag.
4. Claude identifies every item and proposes themed lots.

The app calls Anthropic's API directly from your phone — no backend server.

## Files

```
lot-suggestion-tool/
├── index.html             # HTML shell, loads React + Babel + Tailwind from CDNs
├── app.js                 # All React components + API call logic (one file)
├── sw.js                  # Minimal service worker (required for PWA install)
├── manifest.webmanifest   # App metadata (name, icons, colors)
├── favicon.svg
├── icon-192.png           # PWA icon (small)
├── icon-512.png           # PWA icon (large)
└── README.md
```

The whole app lives in `app.js`. That's where we'll make most changes going forward.

## Upload to GitHub

1. Go to <https://github.com/new>.
2. **Repository name:** `lot-suggestion-tool`.
3. **Visibility:** must be **Public** — GitHub Pages is free only for public repos on the free plan. (There is no API key in these files, so public is safe.)
4. **Do NOT** check "Add a README", "Add .gitignore", or "Choose a license". We already have a README.
5. Click **Create repository**.
6. On the empty repo page, click the **"uploading an existing file"** link.
7. In File Explorer, enter the `lot-suggestion-tool` folder (double-click it), select all contents with Ctrl+A, and drag into the GitHub drop zone. Make sure all 8 files (including the two PNG icons and the SVG favicon) appear in the list.
8. Scroll down and click **Commit changes**.

## Turn on GitHub Pages

1. In your new repo, go to **Settings** (top nav, far right).
2. In the left sidebar click **Pages**.
3. Under **Build and deployment** → **Source**, select **Deploy from a branch**.
4. Under **Branch**, pick `main` and `/ (root)`, then click **Save**.
5. Wait about a minute. Refresh the Pages settings page. You'll see a green box with your site URL: `https://YOUR-USERNAME.github.io/lot-suggestion-tool/`.

That URL is your app. Open it on your Android phone in Chrome.

## Install on your phone

1. Open the site URL in Chrome on Android.
2. Chrome should show an "Install app" banner or a small icon in the address bar. Tap it. (If you don't see it, tap the three-dot menu → **Install app** or **Add to Home screen**.)
3. The app now has its own icon in your app drawer. Open it, paste your Anthropic API key once, and start using it.

## Making changes later

Every change goes through GitHub's web UI:

1. Open your repo at `github.com/YOUR-USERNAME/lot-suggestion-tool`.
2. Click the file you want to edit (usually `app.js`).
3. Click the pencil icon to edit.
4. Paste changes, scroll down, click **Commit changes**.
5. GitHub Pages re-deploys automatically in ~30 seconds.
6. On your phone, pull to refresh the app. New version live.

## Cost / safety notes

- Your Anthropic API key lives only in `localStorage` on the phone that entered it. It is not in the code, not in the repo, and never sent anywhere except directly to `api.anthropic.com`.
- Vision calls cost a few cents per batch at current rates. Set a spend cap in the Anthropic console to sleep easier.
- Because the key is usable from the browser, don't hand this URL to other people — they could paste their own key and use your deployment, but more importantly, the public repo design assumes you're the only user.

## Features

- **Numbered lots** with stable numbers — dissolving a lot doesn't renumber the rest, so your physical piles stay consistent mid-sort.
- **Sorting guide**: a section under the lots listing every item grouped by source photo, with each item's lot number next to it. Use it to pick items off the physical pile and drop them into labeled bins.
- **Copy-to-clipboard pills**: each lot has a clean eBay-ready title as a clickable pill. Tap it, paste into eBay.
- **Stragglers form**: at the bottom of the results, add items Claude missed — either a new photo or a typed list (one item per line). They get placed into existing lots; new lots only when truly needed. Existing assignments aren't touched.
- **Dissolve a lot**: if a lot looks wrong, the "Dissolve" button sends its items back to be reassigned into the remaining existing lots (no new lots created during dissolve).
- **Take photo OR from gallery**: two buttons in each photo picker, pick whichever you need.
- **Not recommended section**: Claude flags items that shouldn't be lotted (e.g. obvious damage) with a reason, used sparingly.

## Roadmap

- Drag items between lots manually after Claude's first pass
- Save past batches
- Per-category prompt tuning (preset category buttons)
- Multi-user version with a serverless proxy
