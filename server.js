'use strict';
// BurnerPad: a non-custodial token launcher. The server only hosts metadata, relays RPC, verifies launches on-chain and
// lists them. It never sees a private key and never holds funds.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chain = require('./chain');
const { trustChecks } = require('./trust');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const META_DIR = path.join(DATA_DIR, 'meta');
const IMG_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(META_DIR, { recursive: true }); fs.mkdirSync(IMG_DIR, { recursive: true });

const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/;
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RETRY_MS = Number(process.env.LAUNCH_RETRY_MS) || 1500;
// Meteora goes live once a curve config exists (scripts/dbc-config.mjs) and DBC_CONFIG is set.
const dbcConfig = () => (B58_RE.test((process.env.DBC_CONFIG || '').trim()) ? process.env.DBC_CONFIG.trim() : '');
// Raydium LaunchLab goes live once a platform exists (scripts/launchlab-platform.mjs) and LAUNCHLAB_PLATFORM is set.
const llPlatform = () => (B58_RE.test((process.env.LAUNCHLAB_PLATFORM || '').trim()) ? process.env.LAUNCHLAB_PLATFORM.trim() : '');
const LAUNCHLAB_PROGRAMS = { mainnet: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', devnet: 'DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6' };
const venues = () => [
  { id: 'pump', name: 'pump.fun', live: true, blurb: 'Bonding curve, graduates to PumpSwap.' },
  { id: 'meteora', name: 'Meteora', live: !!dbcConfig(), blurb: dbcConfig() ? 'Dynamic bonding curve, graduates to a locked DAMM pool.' : 'Dynamic bonding curve. Coming soon.' },
  { id: 'raydium', name: 'Raydium LaunchLab', live: !!llPlatform(), blurb: llPlatform() ? 'Bonding curve, graduates to a Raydium CPMM pool.' : 'Bonding curve to Raydium. Coming soon.' },
];
const liveVenue = (id) => venues().some((v) => v.id === id && v.live);

const cfg = () => {
  const bps = Number.isFinite(Number(process.env.PLATFORM_BPS)) && process.env.PLATFORM_BPS !== '' ? Math.round(Number(process.env.PLATFORM_BPS)) : 100;
  const wallet = B58_RE.test((process.env.PLATFORM_WALLET || '').trim()) ? process.env.PLATFORM_WALLET.trim() : '';
  return {
    // Devnet unless CLUSTER=mainnet, so a missing setting can never spend real SOL.
    cluster: process.env.CLUSTER === 'mainnet' ? 'mainnet' : 'devnet',
    rpc: (process.env.RPC_URL || '').trim(),
    platform: { wallet, bps: wallet ? Math.max(0, Math.min(1000, bps)) : 0 }, // never more than 10%
    maxBuy: process.env.CLUSTER === 'mainnet' ? 10 : 5,
  };
};
const rpcUrl = (c) => {
  if (c.cluster === 'devnet') return /^https?:\/\//.test(process.env.DEVNET_RPC_URL || '') ? process.env.DEVNET_RPC_URL.trim() : 'https://api.devnet.solana.com';
  return /^https?:\/\//.test(c.rpc) ? c.rpc : 'https://api.mainnet-beta.solana.com';
};

const hits = new Map();
function limited(key, max, peek) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < 3600 * 1000);
  if (recent.length >= max) { hits.set(key, recent); return true; }
  if (peek) { hits.set(key, recent); return false; }
  recent.push(now); hits.set(key, recent);
  return false;
}
// Railway puts the real client last in X-Forwarded-For; earlier entries can be forged.
function clientIp(req) {
  const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || req.socket.remoteAddress || 'unknown';
}
async function rpc(c, method, params) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(rpcUrl(c), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
      if (r.status === 429 || r.status >= 500) { last = new Error('RPC ' + r.status); await new Promise((ok) => setTimeout(ok, 400 * (i + 1))); continue; }
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'RPC error');
      return j.result;
    } catch (e) { last = e; await new Promise((ok) => setTimeout(ok, 400 * (i + 1))); }
  }
  throw last || new Error('RPC failed');
}

function send(res, status, body, headers) {
  if (Buffer.isBuffer(body)) { res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }, headers || {})); return res.end(body); }
  const isStr = typeof body === 'string';
  res.writeHead(status, Object.assign({ 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(isStr ? body : JSON.stringify(body));
}
function readBody(req, max) {
  const limit = max || 4096;
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request is too large.'), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function jsonBody(req, res, max) {
  try { const j = JSON.parse(await readBody(req, max)); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch (e) { if (e.status) { send(res, e.status, { error: e.message }); return undefined; } }
  send(res, 400, { error: 'Body must be a JSON object.' });
  return undefined;
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const BLOCKED = ['nigg', 'faggot', 'hitler', 'nazi', 'rape', 'kike', 'chink'].concat((process.env.BLOCKED_WORDS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const badWords = (s) => { const t = String(s).toLowerCase().replace(/[^a-z]/g, ''); return BLOCKED.some((w) => t.includes(w)); };
function cleanTwitter(v) {
  const t = text(v, 120);
  if (!t) return '';
  const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i.exec(t);
  if (m) return 'https://x.com/' + m[1];
  return /^@?[A-Za-z0-9_]{1,15}$/.test(t) ? 'https://x.com/' + t.replace(/^@/, '') : null;
}
function cleanWebsite(v) {
  const t = text(v, 120);
  if (!t) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.') || /\s/.test(t)) return null;
  return u.href.length <= 150 ? u.href : null;
}
function cleanTelegram(v) {
  const t = text(v, 120);
  if (!t) return '';
  const m = /^(?:https?:\/\/)?(?:t|telegram)\.me\/([A-Za-z0-9_+]{3,40})\/?$/i.exec(t);
  return m ? 'https://t.me/' + m[1] : null;
}
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  return proto + '://' + req.headers.host;
}

// ---- images: PNG, JPEG, GIF or WEBP, checked by magic bytes, never by what the browser claims ----
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 4).toString('hex') === '89504e47') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_IMG = 3 * 1024 * 1024;

async function createMetadata(req, res) {
  if (limited('md:' + clientIp(req), 20)) return send(res, 429, { error: 'Too many tries. Try again later.' });
  const input = await jsonBody(req, res, 4.4 * 1024 * 1024); if (!input) return;
  const m = /^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+\/=]+)$/.exec(String(input.image || ''));
  const img = m ? Buffer.from(m[1], 'base64') : null;
  const ext = img && sniffImage(img);
  if (!img || !ext || img.length > MAX_IMG) return send(res, 400, { error: 'Add a PNG, JPG, GIF or WEBP image under 3 MB.' });
  const name = text(input.name, 32), symbol = text(input.symbol, 10), description = text(input.description, 280);
  if (!name) return send(res, 400, { error: 'Name is required.' });
  if (!/^[A-Za-z0-9$._-]{1,10}$/.test(symbol)) return send(res, 400, { error: 'Ticker must be 1 to 10 letters or digits.' });
  if (badWords(name) || badWords(symbol) || badWords(description)) return send(res, 400, { error: 'That name, ticker or description is not allowed here.' });
  const twitter = cleanTwitter(input.twitter); if (twitter === null) return send(res, 400, { error: 'X must be a handle like @yourcoin or an x.com link.' });
  const telegram = cleanTelegram(input.telegram); if (telegram === null) return send(res, 400, { error: 'Telegram must be a t.me link.' });
  const website = cleanWebsite(input.website); if (website === null) return send(res, 400, { error: 'Website must be a link starting with https://.' });
  const id = crypto.randomBytes(8).toString('hex');
  const base = baseUrl(req);
  fs.writeFileSync(path.join(IMG_DIR, id + '.' + ext), img);
  const doc = { name, symbol, description, image: base + '/images/' + id + '.' + ext, external_url: base, createdOn: base };
  if (twitter) doc.twitter = twitter;
  if (telegram) doc.telegram = telegram;
  if (website) doc.website = website;
  fs.writeFileSync(path.join(META_DIR, id + '.json'), JSON.stringify(doc, null, 2));
  send(res, 201, { id, uri: base + '/metadata/' + id + '.json', image: doc.image });
}

// ---- launches ----
const launchesFile = (c) => path.join(DATA_DIR, 'launches-' + c.cluster + '.json');
function loadLaunches(c) { try { const d = JSON.parse(fs.readFileSync(launchesFile(c), 'utf8')); return Array.isArray(d) ? d : []; } catch (e) { return []; } }
function saveLaunches(c, d) { const f = launchesFile(c); fs.writeFileSync(f + '.tmp', JSON.stringify(d)); fs.renameSync(f + '.tmp', f); }

// Reads a launch transaction from the chain: it succeeded, the new coin signed it, and it used the pump.fun program.
// Returns the wallet that paid for it (the first signer).
async function verifyLaunch(c, sig, mint, venue, pool) {
  let tx = null;
  for (let i = 0; i < 6 && !tx; i++) {
    try { tx = await rpc(c, 'getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); }
    catch (e) { tx = null; }
    if (!tx) await new Promise((ok) => setTimeout(ok, RETRY_MS));
  }
  if (!tx || (tx.meta && tx.meta.err)) return { error: 'Could not find that launch on ' + c.cluster + '. If it just went through, try again in a few seconds.' };
  const msg = tx.transaction && tx.transaction.message;
  let keys = ((msg && msg.accountKeys) || []).slice();
  if (tx.meta && tx.meta.loadedAddresses) keys = keys.concat(tx.meta.loadedAddresses.writable || [], tx.meta.loadedAddresses.readonly || []);
  const signers = keys.slice(0, (msg && msg.header && msg.header.numRequiredSignatures) || 1);
  if (venue === 'meteora') {
    // A Meteora launch: the new coin signed it, and it touches our curve config and the pool the page names.
    if (!signers.includes(mint) || !keys.includes(dbcConfig()) || !B58_RE.test(pool || '') || !keys.includes(pool)) return { error: 'That transaction is not a Meteora launch from this platform\'s curve for this coin.' };
    return { wallet: signers[0] };
  }
  if (venue === 'raydium') {
    // A LaunchLab launch: the new coin signed it, and it touches the LaunchLab program, our platform and the pool the page names.
    const prog = LAUNCHLAB_PROGRAMS[c.cluster === 'mainnet' ? 'mainnet' : 'devnet'];
    if (!signers.includes(mint) || !keys.includes(prog) || !keys.includes(llPlatform()) || !B58_RE.test(pool || '') || !keys.includes(pool)) return { error: 'That transaction is not a Raydium LaunchLab launch from this platform for this coin.' };
    return { wallet: signers[0] };
  }
  if (!signers.includes(mint) || !keys.includes(PUMP_PROGRAM)) return { error: 'That transaction is not a pump.fun launch for this coin.' };
  return { wallet: signers[0] };
}

function readMeta(id) { try { return JSON.parse(fs.readFileSync(path.join(META_DIR, id + '.json'), 'utf8')); } catch (e) { return null; } }
function imageIdOf(meta) { const m = meta && /\/images\/([a-f0-9]{16}\.(?:png|jpg|gif|webp))$/.exec(meta.image || ''); return m ? m[1] : ''; }

async function launched(req, res) {
  const c = cfg();
  if (limited('ln:' + clientIp(req), 40)) return send(res, 429, { error: 'Too many requests. Try again later.' });
  const b = await jsonBody(req, res, 2000); if (!b) return;
  const mint = text(b.mint, 60), sig = text(b.signature, 120), id = text(b.metaId, 16), venue = text(b.venue, 20) || 'pump';
  if (!B58_RE.test(mint)) return send(res, 400, { error: 'That is not a valid coin address.' });
  if (!SIG_RE.test(sig)) return send(res, 400, { error: 'That is not a valid transaction signature.' });
  if (!/^[a-f0-9]{16}$/.test(id) || !readMeta(id)) return send(res, 400, { error: 'Unknown metadata for this launch.' });
  if (!liveVenue(venue)) return send(res, 400, { error: 'That venue is not live yet.' });
  const list = loadLaunches(c);
  if (list.some((l) => l.mint === mint)) return send(res, 409, { error: 'That coin is already listed.' });
  const pool = text(b.pool, 60);
  if ((venue === 'meteora' || venue === 'raydium') && !B58_RE.test(pool)) return send(res, 400, { error: 'Missing pool address.' });
  const vr = await verifyLaunch(c, sig, mint, venue, pool);
  if (vr.error) return send(res, 422, { error: vr.error });
  const meta = readMeta(id);
  const split = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(text(b.splitSignature, 120));
  const d = loadLaunches(c); // re-read before writing
  d.unshift({ mint, signature: sig, wallet: vr.wallet, venue, name: meta.name, symbol: meta.symbol, metaId: id, image: imageIdOf(meta), at: Date.now(), pool: venue === 'pump' ? '' : pool, split: venue === 'pump' ? split : false, platformBps: venue === 'pump' && split ? cfg().platform.bps : 0, burner: !!b.burner });
  saveLaunches(c, d.slice(0, 5000));
  send(res, 200, { ok: true });
}

function publicLaunch(r) { return { mint: r.mint, name: r.name, symbol: r.symbol, venue: r.venue, at: r.at, image: r.image ? '/images/' + r.image : '', burner: !!r.burner, split: !!r.split }; }
function launchesApi(res, u) {
  const c = cfg(), venue = text(u.searchParams.get('venue'), 20), q = text(u.searchParams.get('q'), 40).toLowerCase();
  let list = loadLaunches(c);
  if (venue) list = list.filter((l) => l.venue === venue);
  if (q) list = list.filter((l) => l.name.toLowerCase().includes(q) || l.symbol.toLowerCase().includes(q));
  send(res, 200, { cluster: c.cluster, launches: list.slice(0, 60).map(publicLaunch) });
}

const coinCache = new Map();
async function coinInfo(res, mint) {
  const c = cfg();
  if (!B58_RE.test(mint)) return send(res, 404, { error: 'No such coin.' });
  const rec = loadLaunches(c).find((l) => l.mint === mint);
  if (!rec) return send(res, 404, { error: 'That coin was not launched from BurnerPad.' });
  const key = c.cluster + ':' + mint, hit = coinCache.get(key);
  let onchain;
  if (hit && Date.now() - hit.at < 45000) onchain = hit.data;
  else {
    onchain = await chain.coinChain((method, params) => rpc(c, method, params), mint, rec.wallet, rpcUrl(c), { venue: rec.venue });
    coinCache.set(key, { at: Date.now(), data: onchain });
    if (coinCache.size > 200) coinCache.delete(coinCache.keys().next().value);
  }
  const meta = readMeta(rec.metaId) || {};
  send(res, 200, {
    cluster: c.cluster, mint, name: rec.name, symbol: rec.symbol, venue: rec.venue, creator: rec.wallet, burner: !!rec.burner,
    launchedAt: rec.at, signature: rec.signature, image: rec.image ? '/images/' + rec.image : '', description: meta.description || '',
    twitter: meta.twitter || '', telegram: meta.telegram || '', website: meta.website || '', split: !!rec.split, platformBps: rec.platformBps || 0,
    pool: rec.pool || '', onchain, trust: trustChecks(onchain, { venue: rec.venue, split: rec.split, platformBps: rec.platformBps || 0 }),
  });
}

// Coins launched by one wallet, so the claim page can list them. Wallet addresses are already public on-chain.
function myCoinsApi(res, u) {
  const w = text(u.searchParams.get('wallet'), 60);
  if (!B58_RE.test(w)) return send(res, 400, { error: 'That is not a valid wallet address.' });
  const c = cfg();
  const list = loadLaunches(c).filter((l) => l.wallet === w).slice(0, 100).map((l) => ({ mint: l.mint, name: l.name, symbol: l.symbol, venue: l.venue, pool: l.pool || '', at: l.at, split: !!l.split, platformBps: l.platformBps || 0, image: l.image ? '/images/' + l.image : '' }));
  send(res, 200, { cluster: c.cluster, coins: list });
}

function adminOk(req) {
  const token = String(process.env.ADMIN_TOKEN || '').trim();
  if (!token) return false;
  const h = String(req.headers.authorization || '');
  const given = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), crypto.createHash('sha256').update(token).digest());
}
// Everything the owner needs to see what the platform has earned. Gated by ADMIN_TOKEN.
function adminLaunches(req, res) {
  if (!String(process.env.ADMIN_TOKEN || '').trim()) return send(res, 503, { error: 'The admin page is off. Set ADMIN_TOKEN on the server.' });
  if (limited('adminfail:' + clientIp(req), 20, true)) return send(res, 429, { error: 'Too many wrong tries. Wait an hour.' });
  if (!adminOk(req)) { limited('adminfail:' + clientIp(req), 20); return send(res, 401, { error: 'Wrong token.' }); }
  const c = cfg();
  send(res, 200, { cluster: c.cluster, platform: c.platform, dbcConfig: dbcConfig(), launchlabPlatform: llPlatform(), launches: loadLaunches(c).map((l) => ({ mint: l.mint, name: l.name, symbol: l.symbol, venue: l.venue, pool: l.pool || '', wallet: l.wallet, at: l.at, split: !!l.split, platformBps: l.platformBps || 0, burner: !!l.burner })) });
}

function stateApi(res) {
  const c = cfg();
  const feeBps = Number(process.env.DBC_FEE_BPS) || 100, creatorPct = process.env.DBC_CREATOR_FEE_PCT === undefined || process.env.DBC_CREATOR_FEE_PCT === '' ? 90 : Math.max(0, Math.min(100, Number(process.env.DBC_CREATOR_FEE_PCT)));
  // The numbers below are shown on the site only. The real values live in the on-chain config.
  send(res, 200, { cluster: c.cluster, maxBuy: c.maxBuy, platform: c.platform.bps ? c.platform : null, venues: venues(), meteora: dbcConfig() ? { config: dbcConfig(), feeBps, creatorPct } : null,
    // Shown on the site only. The real rates live in the on-chain platform account.
    raydium: llPlatform() ? { platform: llPlatform(), feePct: Number(process.env.LAUNCHLAB_FEE_PCT) || 0.25, creatorPct: process.env.LAUNCHLAB_CREATOR_PCT === undefined || process.env.LAUNCHLAB_CREATOR_PCT === '' ? 0.5 : Number(process.env.LAUNCHLAB_CREATOR_PCT) } : null });
}

// Meteora's SDK finds pools and fee balances by searching its program's accounts. That is the one search allowed through the
// proxy: only that program, and only with a filter, so nobody can pull the whole program through our RPC key.
const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
function dbcScan(params) {
  const p = Array.isArray(params) ? params : [];
  const filters = p[1] && p[1].filters;
  return p[0] === DBC_PROGRAM && Array.isArray(filters) && filters.some((f) => f && f.memcmp);
}
const RPC_METHODS = new Set(['getLatestBlockhash', 'getBlockHeight', 'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getSlot',
  'simulateTransaction', 'sendTransaction', 'getSignatureStatuses', 'getTransaction', 'getGenesisHash', 'getFeeForMessage',
  'getMinimumBalanceForRentExemption', 'getRecentPrioritizationFees', 'getProgramAccounts', 'getTokenAccountBalance', 'getEpochInfo', 'getVersion']);
// Forwards one JSON-RPC call to the private mainnet RPC, so its address never reaches the browser.
async function rpcProxy(req, res) {
  const c = cfg();
  if (c.cluster !== 'mainnet' || !/^https?:\/\//.test(c.rpc)) return send(res, 404, { error: 'Mainnet RPC is not set up here.' });
  if (limited('rpc:' + clientIp(req), 3000)) return send(res, 429, { error: 'Too many requests. Try again later.' });
  let body;
  try { body = JSON.parse(await readBody(req, 200 * 1024)); }
  catch (e) { return send(res, e.status || 400, { error: e.status ? e.message : 'Body must be JSON.' }); }
  if (!body || Array.isArray(body) || typeof body !== 'object' || !RPC_METHODS.has(body.method)) return send(res, 400, { error: 'That call is not allowed.' });
  if (body.method === 'getProgramAccounts' && !dbcScan(body.params)) return send(res, 400, { error: 'That call is not allowed.' });
  try {
    const r = await fetch(c.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id == null ? 1 : body.id, method: body.method, params: Array.isArray(body.params) ? body.params : [] }), signal: AbortSignal.timeout(20000) });
    const out = await r.text();
    res.writeHead(r.status === 429 ? 429 : 200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(out);
  } catch (e) { send(res, 502, { error: 'The mainnet RPC did not answer.' }); }
}

function serveStatic(res, file, type, extra) {
  let data;
  try { data = fs.readFileSync(file); } catch (e) { return send(res, 404, 'Not found'); }
  res.writeHead(200, Object.assign({ 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300' }, extra || {}));
  res.end(data);
}
const page = (res, file) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(fs.readFileSync(path.join(__dirname, file))); };
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0a0a0a"/><defs><linearGradient id="g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff3b1f"/><stop offset="1" stop-color="#ffb02e"/></linearGradient></defs><path d="M32 6c3 9 15 15 15 30a15 15 0 0 1-30 0c0-6 3-10 6-13 0 5 3 7 5 7-2-9 0-17 4-24z" fill="url(#g)"/><path d="M32 32c2 4 7 7 7 13a7 7 0 0 1-14 0c0-3 2-5 3-7 0 3 2 3 3 3-1-4-1-6 1-9z" fill="#fff0a0"/></svg>';
const CORS = { 'Access-Control-Allow-Origin': '*' };

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    if (req.method === 'POST' && p === '/api/metadata') return await createMetadata(req, res);
    if (req.method === 'POST' && p === '/api/launched') return await launched(req, res);
    if (req.method === 'POST' && p === '/api/admin/launches') return adminLaunches(req, res);
    if (req.method === 'POST' && p === '/api/rpc/mainnet') return await rpcProxy(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (p === '/api/state') return stateApi(res);
    if (p === '/api/launches') return launchesApi(res, u);
    if (p === '/api/mycoins') return myCoinsApi(res, u);
    if (p === '/admin') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' }); return res.end(fs.readFileSync(path.join(__dirname, 'admin.html'))); }
    if (p === '/api/health') return send(res, 200, { ok: true });
    { const m = /^\/api\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p); if (m) return await coinInfo(res, m[1]); }
    if (/^\/coin\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p)) return page(res, 'coin.html');
    if (p === '/' || p === '/index.html') return page(res, 'index.html');
    if (p === '/app.css') return serveStatic(res, path.join(__dirname, 'app.css'), 'text/css; charset=utf-8', { 'Cache-Control': 'no-cache' });
    if (p === '/launch.js') {
      const f = path.join(__dirname, 'dist', 'launch.js');
      if (!fs.existsSync(f)) return send(res, 404, 'Not built yet. Run npm run build.');
      return serveStatic(res, f, 'application/javascript; charset=utf-8', { 'Cache-Control': 'no-cache' });
    }
    let mm = /^\/metadata\/([a-f0-9]{16})\.json$/.exec(p);
    if (mm) return serveStatic(res, path.join(META_DIR, mm[1] + '.json'), 'application/json; charset=utf-8', CORS);
    mm = /^\/images\/([a-f0-9]{16})\.(png|jpg|gif|webp)$/.exec(p);
    if (mm) return serveStatic(res, path.join(IMG_DIR, mm[1] + '.' + mm[2]), IMG_MIME[mm[2]], CORS);
    if (p === '/favicon.svg' || p === '/favicon.ico') { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' }); return res.end(FAVICON); }
    return send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Server error.' });
  }
});

if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log('BurnerPad listening on ' + PORT + ', data in ' + DATA_DIR));
module.exports = server;
