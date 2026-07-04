# Position Ledger — Trade Journal

A multi-asset, multi-strategy futures trading journal (MES / MNQ / MCL / MGC), built with React + Vite.

## Run locally

```
npm install
npm run dev
```

## Deploy on Render (static site)

1. Push this folder to a GitHub repo (see below if you need the git commands).
2. In the Render dashboard: **New → Static Site**.
3. Connect the repo.
4. Settings:
   - **Build Command:** `npm install && npm run build`
   - **Publish Directory:** `dist`
5. Click **Create Static Site**. Render will build and give you a `.onrender.com` URL.

That's it — no server, no database needed for this to work.

## Push to GitHub (if you haven't yet)

```
cd trade-journal
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## Important: data storage is per-browser

This app saves trades using the browser's `localStorage` (see `src/storage-shim.js`).
That means:

- Your trades stay on **whatever device/browser** you're using — closing the tab is fine, they persist. Clearing browser data will erase them.
- Trades do **NOT** sync across devices (e.g. phone and laptop won't share the same journal).
- Anyone else who opens your Render URL gets their **own empty journal** — data isn't shared between visitors.

If you eventually want cross-device sync, that requires a small backend + database
(e.g. a free Postgres instance on Render plus a couple of API routes) — happy to help
set that up when/if you need it.
