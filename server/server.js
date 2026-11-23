// Humaniser API proxy — lets the Hashmeta site (unai-humaniser.geo.hashmeta.tech)
// use the Humaniser backends without redirects.
// /api/*  → v1 tool backend at ry4gy5qr.qwenwork.page (session token held by client)
// /v2/*   → redesign studio backend at 2y9cx4z2.qwenwork.page (visitor-id header)
const http = require('http');
const crypto = require('crypto');

const UPSTREAM = 'https://ry4gy5qr.qwenwork.page';
const UPSTREAM2 = 'https://2y9cx4z2.qwenwork.page';
const PORT = process.env.PORT || 8081;
const MAX_BYTES = 11 * 1024 * 1024; // 10 MB image + margin
const ALLOWED_ORIGINS = new Set(['https://unai-humaniser.geo.hashmeta.tech']);

function cors(req, res) {
  const origin = req.headers.origin || '';
  const ok = ALLOWED_ORIGINS.has(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Proxy-Token,X-Visitor-Id');
    res.setHeader('Access-Control-Expose-Headers', 'X-Artwork-Review,Content-Disposition');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }
  return ok;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeToken(req) {
  const raw = req.headers['x-proxy-token'];
  if (!raw) return null;
  try {
    const t = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (typeof t.cookie !== 'string' || typeof t.csrf !== 'string') return null;
    return t;
  } catch { return null; }
}

function upstreamHeaders(token, extra) {
  return Object.assign({
    'Origin': UPSTREAM,
    'Referer': UPSTREAM + '/',
    'Cookie': token.cookie,
    'X-CSRF-Token': token.csrf,
  }, extra || {});
}

async function upFetch(path, opts) {
  return fetch(UPSTREAM + path, opts);
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path === '/' ) { json(res, 200, { ok: true, service: 'humaniser-proxy' }); return; }

    if (path === '/api/status' && req.method === 'GET') {
      const r = await upFetch('/api/status', { headers: { 'Origin': UPSTREAM, 'Referer': UPSTREAM + '/' } });
      json(res, r.status, await r.json());
      return;
    }

    if (path === '/api/session' && req.method === 'GET') {
      const r = await upFetch('/api/session', { headers: { 'Origin': UPSTREAM, 'Referer': UPSTREAM + '/' }, redirect: 'manual' });
      const data = await r.json();
      if (!r.ok || !data.csrf) { json(res, r.status || 502, { message: data.message || 'Could not start a session.' }); return; }
      const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : [])
        .map((c) => c.split(';')[0]).join('; ');
      const token = Buffer.from(JSON.stringify({ cookie: cookies, csrf: data.csrf }), 'utf8').toString('base64url');
      json(res, 200, { csrf: data.csrf, token });
      return;
    }

    if (path === '/api/upload' && req.method === 'POST') {
      const token = decodeToken(req);
      if (!token) { json(res, 401, { message: 'Missing session. Please reload and try again.' }); return; }
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) { json(res, 400, { message: 'Please choose a PNG, JPG or WebP image.' }); return; }
      let body;
      try { body = await readBody(req, MAX_BYTES); } catch { json(res, 413, { message: 'Please choose an image smaller than 10 MB.' }); return; }
      if (!body.length) { json(res, 400, { message: 'Empty file.' }); return; }
      const id = crypto.randomUUID();
      const prep = await upFetch('/api/upload', {
        method: 'POST',
        headers: upstreamHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id, mime, bytes: body.length }),
      });
      const prepData = await prep.json().catch(() => ({}));
      if (!prep.ok || !prepData.upload_url || prepData.upload_id !== id) {
        json(res, prep.status || 502, { message: prepData.message || 'Could not prepare the image upload.' });
        return;
      }
      const put = await fetch(prepData.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': mime, 'If-None-Match': '*' },
        body,
      });
      if (!put.ok) { json(res, 502, { message: 'The image upload did not finish. No generation was requested. Please try again.' }); return; }
      json(res, 200, { upload_id: id });
      return;
    }

    if (path === '/api/humanise' && req.method === 'POST') {
      const token = decodeToken(req);
      if (!token) { json(res, 401, { message: 'Missing session. Please reload and try again.' }); return; }
      const body = await readBody(req, 64 * 1024);
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { json(res, 400, { message: 'Bad request.' }); return; }
      if (!payload.upload_id) { json(res, 400, { message: 'Missing upload_id.' }); return; }
      const r = await upFetch('/api/humanise', {
        method: 'POST',
        headers: upstreamHeaders(token, { 'Content-Type': 'application/json', 'Idempotency-Key': String(payload.upload_id) }),
        body: JSON.stringify({ upload_id: payload.upload_id }),
      });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('image/png')) {
        const buf = Buffer.from(await r.arrayBuffer());
        const h = { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' };
        const review = r.headers.get('x-artwork-review');
        if (review) h['X-Artwork-Review'] = review;
        res.writeHead(r.status, h);
        res.end(buf);
        return;
      }
      const data = await r.json().catch(() => ({}));
      json(res, r.status, data);
      return;
    }

    const jobMatch = path.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
    if (jobMatch && req.method === 'GET') {
      const token = decodeToken(req);
      if (!token) { json(res, 401, { message: 'Missing session.' }); return; }
      const r = await upFetch('/api/jobs/' + jobMatch[1], { headers: upstreamHeaders(token), cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      json(res, r.status, data);
      return;
    }

    if (path === '/api/result' && req.method === 'GET') {
      const token = decodeToken(req);
      if (!token) { json(res, 401, { message: 'Missing session.' }); return; }
      const jobId = url.searchParams.get('job_id') || '';
      const r = await upFetch('/api/result?job_id=' + encodeURIComponent(jobId), { headers: upstreamHeaders(token), cache: 'no-store' });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok) { const data = await r.json().catch(() => ({})); json(res, r.status, data); return; }
      if (!ct.includes('image/png')) { json(res, 502, { message: 'The generation service did not return a PNG.' }); return; }
      const buf = Buffer.from(await r.arrayBuffer());
      const h = { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' };
      const review = r.headers.get('x-artwork-review');
      if (review) h['X-Artwork-Review'] = review;
      res.writeHead(200, h);
      res.end(buf);
      return;
    }

    // --- v2: redesign studio backend (visitor-id identity, no cookies) ---
    const v2Headers = () => ({
      'Origin': UPSTREAM2,
      'Referer': UPSTREAM2 + '/',
      'X-Visitor-Id': String(req.headers['x-visitor-id'] || crypto.randomUUID()),
    });

    if (path === '/v2/config' && req.method === 'GET') {
      const r = await fetch(UPSTREAM2 + '/api/config', { headers: v2Headers(), cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      json(res, r.status, data);
      return;
    }

    if (path === '/v2/humanise' && req.method === 'POST') {
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
        json(res, 400, { error: 'bad_type', message: 'Please upload a PNG, JPG or WebP image.' });
        return;
      }
      let body;
      try { body = await readBody(req, MAX_BYTES); } catch {
        json(res, 413, { message: 'That image is over 10 MB. Please use a smaller file.' });
        return;
      }
      const r = await fetch(UPSTREAM2 + '/api/humanise', {
        method: 'POST',
        headers: Object.assign(v2Headers(), { 'Content-Type': mime }),
        body,
      });
      const data = await r.json().catch(() => ({}));
      json(res, r.status, data);
      return;
    }

    const v2Job = path.match(/^\/v2\/jobs\/([0-9a-f-]{36})(\/result|\/download)?$/i);
    if (v2Job && req.method === 'GET') {
      const sub = v2Job[2] || '';
      const r = await fetch(UPSTREAM2 + '/api/jobs/' + v2Job[1] + sub, { headers: v2Headers(), cache: 'no-store' });
      if (!sub || !r.ok) {
        const data = await r.json().catch(() => ({}));
        json(res, r.status, data);
        return;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const h = { 'Content-Type': r.headers.get('content-type') || 'image/png', 'Cache-Control': 'no-store' };
      const cd = r.headers.get('content-disposition');
      if (cd) h['Content-Disposition'] = cd;
      res.writeHead(200, h);
      res.end(buf);
      return;
    }

    json(res, 404, { message: 'Not found.' });
  } catch (e) {
    json(res, 502, { message: 'The Humaniser service is temporarily unavailable. Please try again.' });
  }
});

const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => console.log('humaniser-proxy listening on ' + HOST + ':' + PORT));