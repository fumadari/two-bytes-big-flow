## Broadcast Gain — BG Demo

A tiny, phone-friendly visual demo of Broadcast-Gain (BG): a 2-byte, stop‑gradient neighbor broadcast that trims tail wait and boosts near‑gate flow under bursty loss.

- Live compare: BG OFF vs BG ON
- Simple metric badge: “BG advantage: +X% throughput”
- Subtle, intuitive visuals: packet flights, consensus gauges, min‑green stretch, lead‑car nudges
- Pure static site (no build). Works on GitHub Pages.

### Quick Start (Local)

- Start a server: `python3 -m http.server 8765`
- Open: http://localhost:8765

### Deploy to GitHub Pages

Option A — via GitHub web UI (fastest)

1. Create a new public repository on GitHub (e.g., `two-bytes-big-flow`).
2. Upload these files (index.html, styles.css, script.js, README.md, .nojekyll).
3. Settings → Pages → Build and deployment:
   - Source: “Deploy from a branch”
   - Branch: `main` (or `master`), Folder: `/ (root)`
4. Wait ~1–2 minutes, then open: `https://<your-username>.github.io/<repo-name>/`

Option B — via git CLI

```
# from this folder
git init
git add .
git commit -m "Initial commit: BG demo"
git branch -M main
# replace URL with your repo's HTTPS URL
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then enable Pages: Settings → Pages → Source = “Deploy from a branch” → `main` / root.

Option C — one‑liner push with a token (if you know what you’re doing)

```
# Create repo on GitHub first. Then:
export GITHUB_TOKEN=<your_token>
export GITHUB_REPO=<your-username>/<repo-name>
[ -d .git ] || git init
git add . && git commit -m "Initial commit: BG demo" || true
git branch -M main || true
# Use token in remote URL (avoid saving token in shell history if possible)
git remote remove origin 2>/dev/null || true
git remote add origin https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git
git push -u origin main
```

### Using the Compare View

- Default landing is a split view: left = BG OFF, right = BG ON.
- Center badge shows “BG advantage: +X% throughput” updating live.
- On mobile, panes stack; badge remains visible.

### Notes

- Pure client-side; no external dependencies.
- To host at a custom path (e.g., `/bg-demo/`), no changes are needed.
- Add a `CNAME` file if you want a custom domain.

Enjoy!
