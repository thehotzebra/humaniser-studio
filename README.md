# Humaniser — Design with a human touch

An AI poster-redesign studio. Upload a poster, flyer or social graphic; Humaniser reads it
like a creative director and redesigns it — keeping every name, date, price and logo
exactly where it belongs.

- **Live (Hashmeta):** https://unai-humaniser.geo.hashmeta.tech
- **Frontend:** `index.html` — a fully self-contained static page (no build step).
- **API proxy:** `server/` — a small Node.js CORS bridge to the redesign backend.

## Architecture

```
browser (index.html)
   │  fetch, X-Visitor-Id header
   ▼
API proxy (server/server.js)        ← publish on any Node host (e.g. QW Pages, Render, Fly)
   │  /v2/*  → studio backend (2y9cx4z2.qwenwork.page)
   │  /api/* → legacy UnAI backend (ry4gy5qr.qwenwork.page)
   ▼
redesign backend (analyze → redesign → review → corrective pass)
```

The proxy exists because the backend apps sit behind a hosting gateway that:
- rejects cross-origin browser preflights (OPTIONS → 404),
- uses SameSite=Lax session cookies,
- caps request bodies at ~1 MB.

The proxy adds proper CORS, sets the required origin/visitor headers server-side, and the
frontend re-encodes large images client-side (WebP quality ladder, JPEG fallback) to fit
the 1 MB channel. The original is kept in the browser for the side-by-side comparison.

## Running locally

```bash
node server/server.js          # listens on PORT (default 8081) and HOST
# then open index.html via any static server, e.g.:
python3 -m http.server 8000
```

`http://localhost:*` origins are allowed by the proxy for local development.

## Deploying

1. **Proxy:** deploy `server/` to any Node.js host. Set `PORT`/`HOST` as required.
   Add your frontend origin to `ALLOWED_ORIGINS` in `server/server.js`.
2. **Frontend:** host `index.html` anywhere static (GitHub Pages, Netlify, …).
   Point the `API` constant in `index.html` at your deployed proxy URL.

### GitHub Pages

The page works as-is on GitHub Pages once the proxy allows your Pages origin
(`https://<username>.github.io`). No build step is required.

## Notes

- No accounts, no settings: one image in, one image out.
- Results carry a quality-check badge ("Verified" / "Unverified preview"); if the
  automated check could not run, the page retries the redesign once automatically.
- The redesign backend is a separate hosted app; this repo contains the frontend and
  the proxy only.