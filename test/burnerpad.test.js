'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = 0n; for (const b of buf) n = n * 256n + BigInt(b);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
const addr = () => b58encode(crypto.randomBytes(32));
let failed = 0;
function check(label, ok, extra) { console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : ' ' + (extra || ''))); if (!ok) failed++; }

(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'burnerpad-'));
  process.env.LAUNCH_RETRY_MS = '5';
  const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const txs = {}; const chainFns = {};
  const fakeRpc = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = JSON.parse(b); let result = null;
      if (j.method === 'getTransaction') result = txs[j.params[0]] || null;
      else if (chainFns[j.method]) result = chainFns[j.method](j.params);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id || 1, result }));
    });
  });
  await new Promise((ok) => fakeRpc.listen(0, '127.0.0.1', ok));
  process.env.DEVNET_RPC_URL = 'http://127.0.0.1:' + fakeRpc.address().port;
  const platform = addr();
  process.env.PLATFORM_WALLET = platform; process.env.PLATFORM_BPS = '100';
  const server = require('../server.js');
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const call = (method, p, body) => new Promise((ok) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* not json */ } ok({ status: res.statusCode, json: j, text: b, headers: res.headers }); });
    });
    if (data) r.write(data); r.end();
  });

  // tiny valid PNG
  const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 1)]).toString('base64');

  // state and pages
  let r = await call('GET', '/api/state');
  check('state: devnet by default, 3 venues, only pump live', r.json.cluster === 'devnet' && r.json.venues.length === 3 && r.json.venues.filter((v) => v.live).map((v) => v.id).join() === 'pump');
  check('state: platform fee 1% published', r.json.platform && r.json.platform.bps === 100 && r.json.platform.wallet === platform);
  r = await call('GET', '/'); check('index served', r.status === 200 && /BurnerPad/.test(r.text) && r.headers['x-frame-options'] === 'DENY');
  r = await call('GET', '/coin/' + addr()); check('coin page served', r.status === 200);
  r = await call('GET', '/app.css'); check('css served', r.status === 200 && /text\/css/.test(r.headers['content-type']));
  r = await call('POST', '/api/rpc/mainnet', { method: 'getSlot', params: [] }); check('mainnet rpc proxy off on devnet', r.status === 404);

  // metadata
  r = await call('POST', '/api/metadata', { name: 'Burner Cat', symbol: 'BCAT', description: 'hi', image: PNG, twitter: '@burnercat', telegram: 't.me/burnercat', website: 'https://example.com' });
  check('metadata: created', r.status === 201 && /^[a-f0-9]{16}$/.test(r.json.id));
  const metaId = r.json.id;
  const doc = await call('GET', '/metadata/' + metaId + '.json');
  check('metadata json served with fields', doc.json && doc.json.name === 'Burner Cat' && doc.json.twitter === 'https://x.com/burnercat' && doc.json.telegram === 'https://t.me/burnercat' && /\/images\/.+\.png$/.test(doc.json.image));
  const imgPath = new URL(doc.json.image).pathname; const im = await call('GET', imgPath);
  check('image served as png', im.status === 200 && im.headers['content-type'] === 'image/png');
  check('metadata: not a real image rejected', (await call('POST', '/api/metadata', { name: 'x', symbol: 'X', image: 'data:image/png;base64,' + Buffer.from('<html>not an image at all</html>').toString('base64') })).status === 400);
  check('metadata: missing image rejected', (await call('POST', '/api/metadata', { name: 'x', symbol: 'X' })).status === 400);
  check('metadata: bad ticker rejected', (await call('POST', '/api/metadata', { name: 'x', symbol: 'no spaces', image: PNG })).status === 400);
  check('metadata: blocked word rejected', (await call('POST', '/api/metadata', { name: 'Hitler Coin', symbol: 'H', image: PNG })).status === 400);
  check('metadata: javascript website rejected', (await call('POST', '/api/metadata', { name: 'x', symbol: 'X', image: PNG, website: 'javascript:alert(1)' })).status === 400);
  check('metadata: bad telegram rejected', (await call('POST', '/api/metadata', { name: 'x', symbol: 'X', image: PNG, telegram: 'https://evil.example/t.me/x' })).status === 400);
  const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(3.2 * 1024 * 1024, 1)]).toString('base64');
  check('metadata: oversize image rejected', [400, 413].includes((await call('POST', '/api/metadata', { name: 'x', symbol: 'X', image: big })).status));

  // launch verification
  const mint = addr(), burner = addr(), sig = b58encode(crypto.randomBytes(64));
  const mkTx = (signers, keys) => ({ meta: { err: null }, transaction: { message: { header: { numRequiredSignatures: signers.length }, accountKeys: signers.concat(keys) } } });
  r = await call('POST', '/api/launched', { mint, signature: sig, metaId, venue: 'pump' });
  check('launched: unknown transaction rejected', r.status === 422);
  txs[sig] = mkTx([burner, mint], [PUMP, addr()]);
  check('launched: bad venue rejected', (await call('POST', '/api/launched', { mint, signature: sig, metaId, venue: 'meteora' })).status === 400);
  check('launched: unknown meta rejected', (await call('POST', '/api/launched', { mint, signature: sig, metaId: 'f'.repeat(16), venue: 'pump' })).status === 400);
  const wrong = b58encode(crypto.randomBytes(64)); txs[wrong] = mkTx([burner], [PUMP]);
  check('launched: tx not signed by the mint rejected', (await call('POST', '/api/launched', { mint, signature: wrong, metaId, venue: 'pump' })).status === 422);
  const noPump = b58encode(crypto.randomBytes(64)); txs[noPump] = mkTx([burner, mint], [addr()]);
  check('launched: tx without pump program rejected', (await call('POST', '/api/launched', { mint, signature: noPump, metaId, venue: 'pump' })).status === 422);
  r = await call('POST', '/api/launched', { mint, signature: sig, metaId, venue: 'pump', burner: true, splitSignature: b58encode(crypto.randomBytes(64)) });
  check('launched: verified launch recorded', r.status === 200, JSON.stringify(r.json));
  check('launched: duplicate rejected', (await call('POST', '/api/launched', { mint, signature: sig, metaId, venue: 'pump' })).status === 409);

  // explore
  r = await call('GET', '/api/launches');
  check('launches: listed without wallet address', r.json.launches.length === 1 && r.json.launches[0].mint === mint && r.json.launches[0].burner === true && !JSON.stringify(r.json).includes(burner));
  check('launches: venue filter', (await call('GET', '/api/launches?venue=pump')).json.launches.length === 1 && (await call('GET', '/api/launches?venue=meteora')).json.launches.length === 0);
  check('launches: search', (await call('GET', '/api/launches?q=bcat')).json.launches.length === 1 && (await call('GET', '/api/launches?q=zzz')).json.launches.length === 0);

  // coin page data and trust checks
  const SUPPLY = 1000000000n * 1000000n;
  chainFns.getTokenSupply = () => ({ value: { amount: SUPPLY.toString(), decimals: 6, uiAmountString: '1000000000' } });
  chainFns.getTokenLargestAccounts = () => ({ value: [{ address: 'a1', amount: (SUPPLY / 20n).toString() }, { address: 'a2', amount: (SUPPLY / 50n).toString() }] });
  chainFns.getMultipleAccounts = () => ({ value: [{ data: { parsed: { info: { owner: addr() } } } }, { data: { parsed: { info: { owner: addr() } } } }] });
  chainFns.getTokenAccountsByOwner = () => ({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: (SUPPLY / 100n).toString() } } } } } }] });
  chainFns.getAccountInfo = (p) => (p[1] && p[1].encoding === 'jsonParsed' ? { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } } : { value: null });
  chainFns.getSignaturesForAddress = () => [];
  r = await call('GET', '/api/coin/' + mint);
  check('coin: found with trust checks', r.status === 200 && Array.isArray(r.json.trust) && r.json.name === 'Burner Cat' && r.json.burner === true);
  const t = Object.fromEntries(r.json.trust.map((x) => [x.id, x]));
  check('trust: authorities revoked are ok', t.mint.status === 'ok' && t.freeze.status === 'ok');
  check('trust: creator 1% is ok', t.dev.status === 'ok', JSON.stringify(t.dev));
  check('trust: top10 under 30% is ok', t.top10.status === 'ok', JSON.stringify(t.top10));
  check('trust: platform fee disclosed', t.fees.status === 'ok' && /1%/.test(t.fees.detail), JSON.stringify(t.fees));
  check('coin: creator wallet exposed on coin page', r.json.creator === burner);
  check('coin: unknown coin 404', (await call('GET', '/api/coin/' + addr())).status === 404);



  // Meteora venue
  check('meteora: not live without DBC_CONFIG', (await call('POST', '/api/launched', { mint: addr(), signature: sig, metaId, venue: 'meteora', pool: addr() })).status === 400);
  const dbcConfigKey = addr(); process.env.DBC_CONFIG = dbcConfigKey; process.env.DBC_FEE_BPS = '100'; process.env.DBC_CREATOR_FEE_PCT = '90';
  r = await call('GET', '/api/state');
  check('meteora: live once configured, with fee numbers', r.json.venues.find((v) => v.id === 'meteora').live === true && r.json.meteora && r.json.meteora.config === dbcConfigKey && r.json.meteora.feeBps === 100 && r.json.meteora.creatorPct === 90);
  const mMint = addr(), mPool = addr(), mSig = b58encode(crypto.randomBytes(64)), mPayer = addr();
  r = await call('POST', '/api/launched', { mint: mMint, signature: mSig, metaId, venue: 'meteora', pool: mPool });
  check('meteora: unknown transaction rejected', r.status === 422);
  txs[mSig] = mkTx([mPayer, mMint], [dbcConfigKey, mPool, addr()]);
  check('meteora: missing pool rejected', (await call('POST', '/api/launched', { mint: mMint, signature: mSig, metaId, venue: 'meteora' })).status === 400);
  const noCfg = b58encode(crypto.randomBytes(64)); txs[noCfg] = mkTx([mPayer, mMint], [mPool, addr()]);
  check('meteora: tx not using our config rejected', (await call('POST', '/api/launched', { mint: mMint, signature: noCfg, metaId, venue: 'meteora', pool: mPool })).status === 422);
  const noPoolTx = b58encode(crypto.randomBytes(64)); txs[noPoolTx] = mkTx([mPayer, mMint], [dbcConfigKey, addr()]);
  check('meteora: tx without the named pool rejected', (await call('POST', '/api/launched', { mint: mMint, signature: noPoolTx, metaId, venue: 'meteora', pool: mPool })).status === 422);
  r = await call('POST', '/api/launched', { mint: mMint, signature: mSig, metaId, venue: 'meteora', pool: mPool, burner: true });
  check('meteora: valid launch recorded', r.status === 200, JSON.stringify(r.json));
  check('meteora: filter finds it', (await call('GET', '/api/launches?venue=meteora')).json.launches.length === 1);
  r = await call('GET', '/api/mycoins?wallet=' + mPayer);
  check('meteora: mycoins carries venue and pool', r.json.coins.length === 1 && r.json.coins[0].venue === 'meteora' && r.json.coins[0].pool === mPool);
  r = await call('GET', '/api/coin/' + mMint);
  const mt = Object.fromEntries(r.json.trust.map((x) => [x.id, x]));
  check('meteora: coin api has pool and a built-in fee note', r.status === 200 && r.json.pool === mPool && r.json.venue === 'meteora' && /Built into/.test(mt.fees.detail), JSON.stringify(mt.fees));

  // my coins and admin
  r = await call('GET', '/api/mycoins?wallet=' + burner);
  check('mycoins: lists coins for that wallet', r.status === 200 && r.json.coins.length === 1 && r.json.coins[0].mint === mint && r.json.coins[0].split === true);
  check('mycoins: other wallet sees none', (await call('GET', '/api/mycoins?wallet=' + addr())).json.coins.length === 0);
  check('mycoins: bad wallet rejected', (await call('GET', '/api/mycoins?wallet=nope')).status === 400);
  r = await call('GET', '/admin'); check('admin page served noindex', r.status === 200 && /noindex/.test(r.headers['x-robots-tag'] || ''));
  check('admin api: off without a token', (await call('POST', '/api/admin/launches')).status === 503);
  process.env.ADMIN_TOKEN = 'secret-token-for-tests-1234567890';
  const adm = (tok) => new Promise((ok) => { const q = http.request({ host: '127.0.0.1', port, path: '/api/admin/launches', method: 'POST', headers: tok ? { Authorization: 'Bearer ' + tok } : {} }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(b) })); }); q.end(); });
  check('admin api: no token is 401', (await adm('')).status === 401);
  check('admin api: wrong token is 401', (await adm('nope')).status === 401);
  r = await adm(process.env.ADMIN_TOKEN);
  const al = r.json.launches.find((x) => x.mint === mint); check('admin api: right token lists launches with wallets and platform share', r.status === 200 && r.json.launches.length === 2 && al && al.wallet === burner && al.platformBps === 100 && r.json.platform.wallet === platform && r.json.dbcConfig === dbcConfigKey, JSON.stringify(r.json).slice(0, 200));

  // trust.js on bad data
  const { trustChecks } = require('../trust.js');
  const bad = Object.fromEntries(trustChecks({ authority: { mint: 'x', freeze: 'y' }, devHoldPct: 35, top10Pct: 70, launch: { capped: false, early: 6, checked: 6, heldPct: 22 } }, { split: false, platformBps: 100 }).map((x) => [x.id, x.status]));
  check('trust: no platform fee says none', trustChecks({}, { split: true, platformBps: 0 }).find((x) => x.id === 'fees').detail.startsWith('None'));
  check('trust: bad data flagged', bad.mint === 'bad' && bad.freeze === 'bad' && bad.dev === 'bad' && bad.top10 === 'bad' && bad.bundle === 'bad' && bad.fees === 'warn', JSON.stringify(bad));
  const unk = Object.fromEntries(trustChecks({}, null).map((x) => [x.id, x.status]));
  check('trust: missing data is unknown, not ok', unk.mint === 'unknown' && unk.dev === 'unknown' && unk.top10 === 'unknown' && unk.bundle === 'unknown');

  // the server must never accept or store a private key
  const stored = fs.readdirSync(process.env.DATA_DIR).join();
  check('no secret-key storage on the server', !/key|secret|wallet/i.test(stored), stored);

  server.close(); fakeRpc.close();
  console.log(failed ? failed + ' FAILED' : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
