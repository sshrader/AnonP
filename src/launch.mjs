// Browser-side coin creation on Solana devnet using the official pump SDK.
// Bundled to dist/launch.js by build.mjs and exposed as window.SparkLaunch.
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage,
  VersionedTransaction, LAMPORTS_PER_SOL, SystemProgram
} from '@solana/web3.js';
import BN from 'bn.js';
import { DynamicBondingCurveClient, getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, feeSharingConfigPda } from '@pump-fun/pump-sdk';
import {
  DEV_API_URLS, DEVNET_PROGRAM_ID, LAUNCHPAD_PROGRAM, LaunchpadPool, Raydium, TxVersion,
  PlatformConfig, getPdaCreatorVault, getPdaLaunchpadConfigId, getPdaLaunchpadPoolId, getPdaPlatformVault
} from '@raydium-io/raydium-sdk-v2';

// The pump program is deployed on devnet at the same address as mainnet.
// Mainnet goes through this site's own /api/rpc/mainnet, so the private RPC address stays on the server.
// That endpoint has no websocket, so mainnet waits for confirmation by polling.
export const CLUSTERS = {
  devnet: { label: 'Devnet', rpc: 'https://api.devnet.solana.com', explorer: 'devnet' },
  mainnet: { label: 'Mainnet', rpc: () => window.location.origin + '/api/rpc/mainnet', explorer: null, mainnet: true, poll: true, priority: 300000 }
};

// Each network has its own genesis hash. A launch only continues if the RPC is the network the person chose.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TOKEN_DECIMALS = 6;
// Coins made with create_v2 use the Token-2022 program.
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
// Pump coins paired with SOL use wrapped SOL as the quote mint.
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MAX_TX_BYTES = 1232;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function message(e) {
  if (e && e.code === 4001) return 'You declined the request.';
  let m = (e && e.message) || String(e);
  const logs = e && e.logs;
  if (Array.isArray(logs) && logs.length) m += ' Logs: ' + logs.slice(-3).join(' | ');
  return m;
}

// Runs one named step. fn(done) calls done('ok', detail, href) itself; a throw marks the step as failed.
async function phase(step, label, fn) {
  const done = step(label);
  try { return await fn(done); }
  catch (e) { done('err', message(e)); throw e; }
}

const clusterQuery = (cfg) => (cfg.explorer ? '?cluster=' + cfg.explorer : '');
function explorerTx(cfg, sig) {
  return 'https://explorer.solana.com/tx/' + sig + clusterQuery(cfg);
}
function explorerAddress(cfg, addr) {
  return 'https://explorer.solana.com/address/' + addr + clusterQuery(cfg);
}

function config(cluster) {
  const base = CLUSTERS[cluster];
  if (!base) throw new Error('Unknown network: ' + cluster);
  return Object.assign({}, base, { rpc: typeof base.rpc === 'function' ? base.rpc() : base.rpc });
}

async function checkNetwork(conn, cfg) {
  const genesis = await conn.getGenesisHash();
  if (cfg.mainnet && genesis !== MAINNET_GENESIS) throw new Error('The mainnet connection is not answering as mainnet. Refusing to continue.');
  if (!cfg.mainnet && genesis === MAINNET_GENESIS) throw new Error('This RPC is mainnet. Refusing to continue.');
}

// Waits for a transaction by polling, and re-sends the same signed transaction every few seconds in case it was dropped.
async function pollConfirm(conn, sig, raw, lastValidBlockHeight) {
  for (let i = 0; i < 80; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st && st.err) throw new Error('Transaction failed: ' + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return;
    if (i > 0 && i % 4 === 0) {
      try { await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); } catch (e) { /* the first send may already have landed */ }
      if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error('The transaction expired before it was confirmed. Nothing was spent. Try again.');
    }
    await wait(1200);
  }
  throw new Error('Still waiting for confirmation after about 90 seconds. Check the signature on Solana Explorer before trying again.');
}

function tokensLabel(baseUnits) {
  const whole = Number(baseUnits.div(new BN(10).pow(new BN(TOKEN_DECIMALS))).toString());
  return whole.toLocaleString('en-US');
}

export async function airdrop(cluster, address, sol) {
  const cfg = config(cluster);
  if (cfg.mainnet) throw new Error('There is no faucet on mainnet.');
  const conn = new Connection(cfg.rpc, 'confirmed');
  const latest = await conn.getLatestBlockhash('confirmed');
  const sig = await conn.requestAirdrop(new PublicKey(address), (sol || 1) * LAMPORTS_PER_SOL);
  await conn.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
  return sig;
}

function statsFrom(info, global) {
  if (!info) return null;
  try {
    const c = PUMP_SDK.decodeBondingCurve(info);
    const initial = global.initialRealTokenReserves;
    let sold = initial.gtn(0) ? 100 - Number(c.realTokenReserves.muln(10000).div(initial).toString()) / 100 : 0;
    if (c.complete) sold = 100;
    sold = Math.max(0, Math.min(100, sold));
    const mcapLamports = c.virtualTokenReserves.gtn(0)
      ? c.virtualQuoteReserves.mul(c.tokenTotalSupply).div(c.virtualTokenReserves)
      : new BN(0);
    return { soldPct: sold, mcapSol: Number(mcapLamports.toString()) / LAMPORTS_PER_SOL, complete: !!c.complete };
  } catch (e) {
    return null;
  }
}

// The coin's on-chain fee split, or null if none is set.
function splitFrom(info) {
  if (!info) return null;
  try {
    const sc = PUMP_SDK.decodeSharingConfig(info);
    return {
      locked: !!sc.adminRevoked,
      shareholders: (sc.shareholders || []).map((s) => ({ address: s.address.toBase58(), shareBps: Number(s.shareBps) }))
    };
  } catch (e) {
    return null;
  }
}

// Reads each coin's bonding curve and fee split from the network.
// Returns one entry per mint, or null where the curve could not be read.
export async function curveStats(cluster, mints) {
  const cfg = config(cluster);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const online = new OnlinePumpSdk(conn);
  const global = await online.fetchGlobal();
  const keys = mints.map((m) => PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(m).toBuffer()], PUMP_PROGRAM)[0]);
  const shareKeys = mints.map((m) => feeSharingConfigPda(new PublicKey(m)));
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const [curveInfos, shareInfos] = await Promise.all([
      conn.getMultipleAccountsInfo(keys.slice(i, i + 100)),
      conn.getMultipleAccountsInfo(shareKeys.slice(i, i + 100))
    ]);
    curveInfos.forEach((info, j) => {
      const s = statsFrom(info, global);
      out.push(s ? Object.assign(s, { split: splitFrom(shareInfos[j]) }) : null);
    });
  }
  return out;
}

// Dry run, ask Phantom to sign, add any extra signer, send, confirm. Returns the signature.
async function signAndSend({ step, conn, cfg, wallet, tx, extraSigner, labels, dryRetries }) {
  await phase(step, labels.dry, async (done) => {
    // dryRetries covers a brand new lookup table, which can take a moment before it can be used.
    let sim = null;
    for (let i = 0; i <= (dryRetries || 0); i++) {
      sim = await conn.simulateTransaction(tx);
      if (!sim.value.err) break;
      if (i < (dryRetries || 0)) await wait(1500);
    }
    if (sim.value.err) {
      const tail = (sim.value.logs || []).slice(-4).join(' | ');
      throw new Error('The network rejected the dry run: ' + JSON.stringify(sim.value.err) + (tail ? '. ' + tail : ''));
    }
    done('ok', 'Passed, ' + (sim.value.unitsConsumed || '?') + ' compute units');
  });

  // Phantom signs first, then the new mint (if any) signs, so a wallet that adjusts the transaction cannot invalidate that signature.
  const signed = await phase(step, labels.sign, async (done) => {
    const s = await wallet.signTransaction(tx);
    if (extraSigner) { if (typeof s.partialSign === 'function') s.partialSign(extraSigner); else s.sign([extraSigner]); }
    done('ok', extraSigner ? 'Signed by your wallet and the new mint' : 'Signed by your wallet');
    return s;
  });

  return await phase(step, labels.send, async (done) => {
    const latest = await conn.getLatestBlockhash('confirmed');
    const raw = signed.serialize();
    // Public RPCs sit behind several nodes, and the one that checks the transaction can be a moment behind the one that
    // issued its blockhash ("Blockhash not found"). Resending the same signed transaction is safe: it can only land once.
    let sig = null;
    for (let i = 0; i < 6 && !sig; i++) {
      try {
        sig = await conn.sendRawTransaction(raw, { skipPreflight: i >= 4, preflightCommitment: 'processed' });
      } catch (e) {
        if (i === 5 || !/blockhash not found/i.test(String((e && e.message) || e))) throw e;
        await wait(1200);
      }
    }
    if (cfg.poll) {
      await pollConfirm(conn, sig, raw, latest.lastValidBlockHeight);
    } else {
      const res = await conn.confirmTransaction({ signature: sig, blockhash: signed.recentBlockhash || (signed.message && signed.message.recentBlockhash) || latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
      if (res.value.err) throw new Error('Transaction failed: ' + JSON.stringify(res.value.err));
    }
    done('ok', 'Confirmed ' + sig.slice(0, 12) + '… View on Solana Explorer', explorerTx(cfg, sig));
    return sig;
  });
}

// ---------- Creator fees ----------

// SOL waiting in the creator's fee vaults (bonding curve and open market), in SOL.
export async function creatorFees(cluster, address) {
  const cfg = config(cluster);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const bal = await new OnlinePumpSdk(conn).getCreatorVaultBalanceBothPrograms(new PublicKey(address));
  return Number(bal.toString()) / LAMPORTS_PER_SOL;
}

// Sends the creator's accrued fees to the creator's own wallet. Coins with a fee split are paid out by the split instead.
export async function claimCreatorFees({ cluster, wallet, user }, step) {
  const cfg = config(cluster);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const userKey = new PublicKey(user);
  await phase(step, 'Network check', async (done) => {
    await checkNetwork(conn, cfg);
    done('ok', cfg.label);
  });
  const tx = await phase(step, 'Build claim', async (done) => {
    const online = new OnlinePumpSdk(conn);
    const bal = await online.getCreatorVaultBalanceBothPrograms(userKey);
    if (bal.lten(0)) throw new Error('Nothing to claim yet. Fees build up as people trade your coins.');
    const ixs = await online.collectCoinCreatorFeeInstructions(userKey, userKey);
    const t = new Transaction().add(...ixs);
    t.feePayer = userKey;
    t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    done('ok', 'Claiming about ' + (Number(bal.toString()) / LAMPORTS_PER_SOL).toFixed(6) + ' SOL to your wallet');
    return t;
  });
  return await signAndSend({ step, conn, cfg, wallet, tx, labels: { dry: 'Dry run (claim)', sign: 'Approve claim', send: 'Send claim' } });
}

// For a coin with a fee split, trading fees wait in the coin's vault until someone pays them out to the shareholders.
// This reads how much is waiting and whether the pump program will pay it out right now.
export async function distributableFees(cluster, mint) {
  const cfg = config(cluster);
  const online = new OnlinePumpSdk(new Connection(cfg.rpc, 'confirmed'));
  if (typeof online.getMinimumDistributableFee !== 'function') throw new Error('This version of the pump SDK cannot read split fees.');
  const r = await online.getMinimumDistributableFee(new PublicKey(mint));
  const sol = (v) => Number(v.toString()) / LAMPORTS_PER_SOL;
  return { sol: sol(r.distributableFees), min: sol(r.minimumRequired), canDistribute: !!r.canDistribute };
}

// Pays a coin's waiting fees out to its shareholders by their shares (for example 95% to the launcher, 5% to the Den).
export async function distributeCoinFees({ cluster, wallet, user, mint }, step) {
  const cfg = config(cluster);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const userKey = new PublicKey(user);
  await phase(step, 'Network check', async (done) => {
    await checkNetwork(conn, cfg);
    done('ok', cfg.label);
  });
  const tx = await phase(step, 'Build payout', async (done) => {
    const online = new OnlinePumpSdk(conn);
    if (typeof online.buildDistributeCreatorFeesInstructions !== 'function') throw new Error('This version of the pump SDK cannot pay out split fees.');
    const mintKey = new PublicKey(mint);
    const info = await distributableFees(cluster, mint);
    if (!info.canDistribute) throw new Error('Not enough fees to pay out yet (' + info.sol.toFixed(6) + ' SOL waiting, ' + info.min.toFixed(6) + ' needed).');
    // payer signs the creator-fee sweeps that run first when trades left fees behind in the curve or pool.
    const built = await online.buildDistributeCreatorFeesInstructions(mintKey, { payer: userKey });
    const ixs = Array.isArray(built) ? built : built.instructions;
    const sweeps = built && built.sweepCount ? built.sweepCount : 0;
    const t = new Transaction().add(...ixs);
    t.feePayer = userKey;
    t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    done('ok', 'Paying out about ' + info.sol.toFixed(6) + ' SOL to the shareholders' + (sweeps ? ' (after sweeping fees from ' + sweeps + ' source' + (sweeps === 1 ? '' : 's') + ')' : ''));
    return t;
  });
  return await signAndSend({ step, conn, cfg, wallet, tx, labels: { dry: 'Dry run (payout)', sign: 'Approve payout', send: 'Send payout' } });
}

// ---------- One-transaction launch: create + the creator's first buy ----------
// Create and buy together are 1501 bytes, over the 1232 byte limit for a normal transaction. A version 0 transaction
// with an address lookup table swaps the shared addresses for one-byte indexes, so both fit in one transaction.
// One transaction means the coin and the creator's buy land in the same block, so nobody can buy in between.

const LUT_CHUNK = 18;

function keysOf(ixs) {
  const out = new Set();
  for (const ix of ixs) {
    out.add(ix.programId.toBase58());
    for (const k of ix.keys) out.add(k.pubkey.toBase58());
  }
  return out;
}

// Addresses that are the same for every launch by this wallet. Found by building the instructions for two different
// throwaway mints and keeping what the two have in common (the creator's own wallet signs, so it is left out).
async function sharedAddresses({ global, userKey, amount, lamports, name, symbol, uri }) {
  const build = (mint) => PUMP_SDK.createV2AndBuyV2Instructions({
    global, mint, name, symbol, uri, creator: userKey, user: userKey, amount, quoteAmount: lamports, mayhemMode: false, slippage: 1
  });
  const [a, b] = await Promise.all([build(Keypair.generate().publicKey), build(Keypair.generate().publicKey)]);
  const kb = keysOf(b);
  return [...keysOf(a)].filter((k) => kb.has(k) && k !== userKey.toBase58());
}

function savedTable(cfg, userKey) {
  try { return localStorage.getItem('spark-lut:' + cfg.explorer + ':' + userKey.toBase58()); } catch (e) { return null; }
}
function saveTable(cfg, userKey, addr) {
  try { localStorage.setItem('spark-lut:' + cfg.explorer + ':' + userKey.toBase58(), addr); } catch (e) { /* only a convenience */ }
}

// Finds or builds the lookup table holding the shared addresses. Setting it up takes one or two wallet approvals, once.
async function ensureLookupTable({ step, conn, cfg, wallet, userKey, keys, tableHint, onTable }) {
  return await phase(step, 'Lookup table', async (done) => {
    let table = null;
    let why = 'no saved table in this browser';
    const saved = savedTable(cfg, userKey) || tableHint || null;
    if (saved) {
      why = 'saved table could not be read';
      // A node that is a moment behind can answer "not found" for a table that exists, so ask a few times.
      for (let i = 0; i < 4 && !table; i++) {
        try { table = (await conn.getAddressLookupTable(new PublicKey(saved), { commitment: 'confirmed' })).value; } catch (e) { table = null; }
        if (!table && i < 3) await wait(800);
      }
      // Only trust a table this wallet controls, so a copied or altered saved value cannot swap in someone else's.
      if (table && !(table.state.authority && table.state.authority.equals(userKey))) { table = null; why = 'saved table is not controlled by this wallet'; }
    }
    if (!table) console.info('[launch] building a new lookup table:', why);
    const have = new Set(table ? table.state.addresses.map((x) => x.toBase58()) : []);
    const missing = keys.filter((k) => !have.has(k));
    if (table && !missing.length) { done('ok', 'Using your saved table ' + table.key.toBase58().slice(0, 6) + '…'); return { table, fresh: false }; }

    let tableKey = table ? table.key : null;
    const chunks = [];
    for (let i = 0; i < missing.length; i += LUT_CHUNK) chunks.push(missing.slice(i, i + LUT_CHUNK).map((k) => new PublicKey(k)));
    for (let i = 0; i < chunks.length; i++) {
      const n = chunks.length > 1 ? ' ' + (i + 1) + '/' + chunks.length : '';
      // The create step names a recent slot, and a node that is a little behind can refuse it ("not a recent slot").
      // Nothing is signed until the dry run passes, so on that error ask again with an older slot.
      for (let attempt = 0; ; attempt++) {
        const ixs = [];
        const creating = !tableKey || (attempt > 0 && i === 0 && !table);
        if (creating) {
          const slot = Math.max(1, (await conn.getSlot('finalized')) - attempt * 24); // a finalized slot is already in the network's recent-slot list; the latest one is not
          const [createIx, addr] = AddressLookupTableProgram.createLookupTable({ authority: userKey, payer: userKey, recentSlot: slot });
          ixs.push(createIx);
          tableKey = addr;
        }
        ixs.push(AddressLookupTableProgram.extendLookupTable({ payer: userKey, authority: userKey, lookupTable: tableKey, addresses: chunks[i] }));
        const t = new Transaction().add(...ixs);
        t.feePayer = userKey;
        t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
        try {
          await signAndSend({ step, conn, cfg, wallet, tx: t, labels: { dry: 'Dry run (lookup table' + n + ')', sign: 'Approve lookup table' + n + '', send: 'Send lookup table' + n } });
          break;
        } catch (e) {
          if (!creating || attempt >= 3 || !/not a recent slot/i.test(String((e && e.message) || e))) throw e;
          await wait(1000);
        }
      }
      // Remember the table as soon as it exists, so a declined or failed second step does not strand it. The next try fills in what is missing.
      saveTable(cfg, userKey, tableKey.toBase58());
      if (onTable) { try { await onTable(tableKey.toBase58()); } catch (e) { /* only a convenience */ } }
    }
    saveTable(cfg, userKey, tableKey.toBase58());
    if (onTable) { try { await onTable(tableKey.toBase58()); } catch (e) { /* only a convenience */ } }

    // Wait until the network shows every address, then a little longer: a table is usable from the slot after it is filled.
    let fresh = null;
    for (let i = 0; i < 12; i++) {
      fresh = (await conn.getAddressLookupTable(tableKey)).value;
      if (fresh && keys.every((k) => fresh.state.addresses.some((x) => x.toBase58() === k))) break;
      fresh = null;
      await wait(1000);
    }
    if (!fresh) throw new Error('The lookup table was created but is not readable yet. Try the launch again in a few seconds.');
    await wait(2500);
    done('ok', 'Table ready with ' + fresh.state.addresses.length + ' addresses (new table: ' + why + ')');
    return { table: fresh, fresh: true };
  });
}

// Create the coin and buy it in one transaction. Throws before anything is sent if it cannot be built.
async function createAndBuy({ step, conn, cfg, wallet, userKey, mint, name, symbol, uri, lamports, devBuySol, priorityMicroLamports, tableHint, onTable }) {
  const online = new OnlinePumpSdk(conn);
  const built = await phase(step, 'Build create + buy', async (done) => {
    const global = await online.fetchGlobal();
    let feeConfig = null;
    try { feeConfig = await online.fetchFeeConfig(); } catch (e) { /* the quote also works without it */ }
    // A brand new coin has no curve yet, so the first buy is priced against a fresh one.
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: lamports, quoteMint: NATIVE_MINT });
    if (amount.lten(0)) throw new Error('That dev buy size returns no tokens. Try a larger amount.');
    const ixs = await PUMP_SDK.createV2AndBuyV2Instructions({
      global, mint: mint.publicKey, name, symbol, uri, creator: userKey, user: userKey,
      amount, quoteAmount: lamports, mayhemMode: false, slippage: 1
    });
    const shared = await sharedAddresses({ global, userKey, amount, lamports, name, symbol, uri });
    done('ok', 'Mint ' + mint.publicKey.toBase58() + '. ' + devBuySol + ' SOL for about ' + tokensLabel(amount) + ' tokens, in the same transaction as the launch', explorerAddress(cfg, mint.publicKey.toBase58()));
    return { ixs, shared, amount };
  });

  const { table, fresh } = await ensureLookupTable({ step, conn, cfg, wallet, userKey, keys: built.shared, tableHint, onTable });

  const tx = await phase(step, 'Pack into one transaction', async (done) => {
    const pre = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })];
    if (priorityMicroLamports > 0) pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
    const msg = new TransactionMessage({
      payerKey: userKey,
      recentBlockhash: (await conn.getLatestBlockhash('confirmed')).blockhash,
      instructions: pre.concat(built.ixs)
    }).compileToV0Message([table]);
    const vtx = new VersionedTransaction(msg);
    const size = vtx.serialize().length;
    if (size > MAX_TX_BYTES) throw new Error('Still too large for one transaction (' + size + ' of ' + MAX_TX_BYTES + ' bytes).');
    done('ok', size + ' of ' + MAX_TX_BYTES + ' bytes');
    return vtx;
  });

  return await signAndSend({
    step, conn, cfg, wallet, tx, extraSigner: mint, dryRetries: fresh ? 6 : 1,
    labels: { dry: 'Dry run (create + buy)', sign: 'Approve create + buy', send: 'Send create + buy' }
  });
}

// Splits the coin's creator fees between the listed wallets and locks the list, so it cannot be changed later.
// Needs createFeeSharingConfig, then updateFeeSharesV2. One transaction if it fits, otherwise two.
async function lockFeeSplit({ step, conn, cfg, wallet, userKey, mint, shareholders }) {
  const txs = await phase(step, 'Build fee split', async (done) => {
    const create = await PUMP_SDK.createFeeSharingConfig({ creator: userKey, mint, pool: null });
    const update = await PUMP_SDK.updateFeeSharesV2({
      authority: userKey,
      mint,
      currentShareholders: [userKey],
      newShareholders: shareholders.map((s) => ({ address: new PublicKey(s.address), shareBps: s.shareBps })),
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM
    });
    const blockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    const make = (ixs) => {
      const t = new Transaction().add(...ixs);
      t.feePayer = userKey;
      t.recentBlockhash = blockhash;
      return t;
    };
    let list = [make([create, update])];
    const size = list[0].serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    if (size > MAX_TX_BYTES) list = [make([create]), make([update])];
    done('ok', shareholders.map((s) => (s.shareBps / 100) + '% to ' + s.address.slice(0, 4) + '…' + s.address.slice(-4)).join(', ') + (list.length > 1 ? '. Two transactions.' : ''));
    return list;
  });

  let last = null;
  for (let i = 0; i < txs.length; i++) {
    const n = txs.length > 1 ? ' ' + (i + 1) + '/' + txs.length : '';
    last = await signAndSend({
      step, conn, cfg, wallet, tx: txs[i],
      labels: { dry: 'Dry run (fee split' + n + ')', sign: 'Approve fee split' + n + '', send: 'Send fee split' + n }
    });
  }
  return last;
}

// Second transaction: the creator buys their own coin. Create plus buy together is over the 1232 byte limit.
async function devBuy({ step, conn, cfg, wallet, userKey, mint, lamports, devBuySol }) {
  const online = new OnlinePumpSdk(conn);

  const tx = await phase(step, 'Build dev buy', async (done) => {
    const global = await online.fetchGlobal();
    let feeConfig = null;
    try { feeConfig = await online.fetchFeeConfig(); } catch (e) { /* the quote also works without it */ }

    // The new coin may take a moment to be readable.
    let state = null, lastErr = null;
    for (let i = 0; i < 6 && !state; i++) {
      try { state = await online.fetchBuyState(mint, userKey, TOKEN_2022); }
      catch (e) { lastErr = e; await wait(1000); }
    }
    if (!state) throw lastErr || new Error('The new coin could not be read yet.');

    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: lamports,
      quoteMint: state.quoteMint
    });
    if (amount.lten(0)) throw new Error('That dev buy size returns no tokens. Try a larger amount.');

    // quoteAmount is a spending cap. The SDK adds 1% slippage on top of it.
    const ixs = await PUMP_SDK.buyV2Instructions({
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint,
      user: userKey,
      amount,
      quoteAmount: lamports,
      slippage: 1,
      tokenProgram: TOKEN_2022,
      quoteTokenProgram: state.quoteTokenProgram
    });
    const t = new Transaction();
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
    t.add(...ixs);
    t.feePayer = userKey;
    t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    done('ok', devBuySol + ' SOL for about ' + tokensLabel(amount) + ' tokens');
    return t;
  });

  return await signAndSend({
    step, conn, cfg, wallet, tx,
    labels: { dry: 'Dry run (dev buy)', sign: 'Approve dev buy', send: 'Send dev buy' }
  });
}

// wallet is Phantom's provider. step(label) returns done(state, detail, href), as in the page's log.
// devBuySol is how much SOL the creator spends buying their own coin right after launch (0 for none).
// shareholders is an optional list of { address, shareBps } for the creator fee split (basis points, total 10000).
// atomic (default true): with a dev buy, create and buy go in ONE transaction so nobody can buy in between.
// allowSplitFallback: if the one-transaction launch cannot be built, fall back to two transactions. Devnet only.
// The quote coins a new coin can be priced in, as the pump program lists them (mainnet only). Each is { mint, source }.
export async function listQuoteMints(cluster) {
  const cfg = config(cluster);
  if (!cfg.mainnet) return [];
  const online = new OnlinePumpSdk(new Connection(cfg.rpc, 'confirmed'));
  const list = await online.fetchSupportedQuoteMints();
  return list.map((q) => ({ mint: q.mint.toBase58(), source: String(q.source) }));
}

// quoteMint (optional, mainnet only): launch the coin priced in that quote coin instead of SOL, such as a tokenized stock.
// A quote-pair launch is create-only for now: no first buy and no fee split, so nobody has to hold the quote coin to launch.
export async function createCoin({ cluster, wallet, user, name, symbol, uri, devBuySol, shareholders, atomic, allowSplitFallback, priorityMicroLamports, tableHint, onTable, quoteMint }, step) {
  const cfg = config(cluster);
  const paired = !!quoteMint && quoteMint !== 'SOL';
  if (paired && !cfg.mainnet) throw new Error('Quote pairs are only available on mainnet.');
  if (paired) { devBuySol = 0; shareholders = null; }
  const conn = new Connection(cfg.rpc, 'confirmed');
  const userKey = new PublicKey(user);
  let mint = Keypair.generate();
  const lamports = new BN(Math.round((devBuySol || 0) * LAMPORTS_PER_SOL));

  await phase(step, 'Network check', async (done) => {
    await checkNetwork(conn, cfg);
    const bal = await conn.getBalance(userKey);
    const sol = bal / LAMPORTS_PER_SOL;
    const need = (cfg.mainnet ? 0.08 : 0.06) + (devBuySol || 0);
    if (cfg.mainnet && sol < need) throw new Error('Balance is ' + sol.toFixed(3) + ' SOL. A ' + (devBuySol || 0) + ' SOL dev buy plus fees needs about ' + need.toFixed(2) + ' SOL.');
    done(sol < need ? 'warn' : 'ok', cfg.label + ', balance ' + sol.toFixed(3) + ' SOL' + (sol < need ? '. You may need more. Use the faucet button if the launch fails.' : ''));
  });

  const result = { signature: null, mint: mint.publicKey.toBase58(), buySignature: null, buyError: null, splitSignature: null, splitError: null, atomic: false };
  const wantBuy = lamports.gtn(0);

  if (wantBuy && atomic !== false) {
    try {
      result.signature = await createAndBuy({ step, conn, cfg, wallet, userKey, mint, name, symbol, uri, lamports, devBuySol, priorityMicroLamports: priorityMicroLamports != null ? priorityMicroLamports : (cfg.priority || 0), tableHint, onTable });
      result.buySignature = result.signature;
      result.atomic = true;
    } catch (e) {
      // Nothing was created if this failed, because one transaction either lands whole or not at all.
      if (!allowSplitFallback || cfg.mainnet || (e && e.code === 4001)) throw e; // never split a mainnet launch into two transactions
      step('One-transaction launch failed')('warn', message(e) + ' Falling back to two transactions, which a bot could slip between.');
      mint = Keypair.generate(); // fresh mint, in case the first attempt landed after all
      result.mint = mint.publicKey.toBase58();
    }
  }

  if (!result.signature) {
    const tx = await phase(step, 'Build create transaction', async (done) => {
      let qArgs = {};
      if (paired) {
        const r = await new OnlinePumpSdk(conn).resolveQuoteMint(new PublicKey(quoteMint));
        const chain = r.pumpQuote && r.pumpQuote.accounts && r.pumpQuote.accounts.chain;
        if (chain && chain.length) throw new Error('That pair sits on a deeper quote chain than this launcher supports yet. Pick another pair.');
        qArgs = { quoteMint: r.mint, quoteTokenProgram: r.quoteTokenProgram };
        if (r.pumpQuote) qArgs.pumpQuote = r.pumpQuote.accounts;
      }
      const ix = await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey,
        name,
        symbol,
        uri,
        creator: userKey,
        user: userKey,
        mayhemMode: false,
        ...qArgs
      });
      const t = new Transaction();
      if (paired) {
        t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
        const pr = priorityMicroLamports != null ? priorityMicroLamports : (cfg.priority || 0);
        if (pr > 0) t.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: pr }));
      }
      t.add(ix);
      t.feePayer = userKey;
      t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
      done('ok', 'Mint ' + mint.publicKey.toBase58() + (paired ? ', priced in ' + quoteMint.slice(0, 4) + '...' + quoteMint.slice(-4) : ''), explorerAddress(cfg, mint.publicKey.toBase58()));
      return t;
    });
    result.signature = await signAndSend({
      step, conn, cfg, wallet, tx, extraSigner: mint,
      labels: { dry: 'Dry run', sign: 'Sign', send: 'Send and confirm' }
    });
  }

  // The coin exists now. If a later step fails, report it but keep the launch result.
  if (shareholders && shareholders.length) {
    try {
      result.splitSignature = await lockFeeSplit({ step, conn, cfg, wallet, userKey, mint: mint.publicKey, shareholders });
    } catch (e) {
      result.splitError = message(e);
    }
  }
  if (wantBuy && !result.atomic) {
    try {
      result.buySignature = await devBuy({ step, conn, cfg, wallet, userKey, mint: mint.publicKey, lamports, devBuySol });
    } catch (e) {
      result.buyError = message(e);
    }
  }
  return result;
}

// ---------- Burner wallets ----------
// A burner is a fresh keypair made in this browser. The secret never goes to the server. The person funds it
// from their own wallet, so BurnerPad never holds money. It speaks the same signTransaction interface as Phantom.
export function newBurner() {
  const kp = Keypair.generate();
  return burnerFromSecret(kp.secretKey);
}
export function burnerFromSecret(secret) {
  const kp = Keypair.fromSecretKey(secret instanceof Uint8Array ? secret : Uint8Array.from(secret));
  return {
    address: kp.publicKey.toBase58(),
    secret: Array.from(kp.secretKey),
    wallet: {
      publicKey: kp.publicKey,
      signTransaction: async (tx) => { if (typeof tx.partialSign === 'function') tx.partialSign(kp); else tx.sign([kp]); return tx; }
    },
    keypair: kp
  };
}
// The secret as base58, which is what Phantom and Solflare accept when importing a private key.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function secretToBase58(secret) {
  let n = 0n; for (const b of secret) n = n * 256n + BigInt(b);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of secret) { if (b === 0) out = '1' + out; else break; }
  return out;
}
export async function balanceOf(cluster, address) {
  const cfg = config(cluster);
  return (await new Connection(cfg.rpc, 'confirmed').getBalance(new PublicKey(address))) / LAMPORTS_PER_SOL;
}
// Sends what is left in the burner (minus the network fee) to another address, closing it out.
export async function sweep({ cluster, burner, to }, step) {
  const cfg = config(cluster);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const dest = new PublicKey(to);
  const lamports = await conn.getBalance(burner.keypair.publicKey);
  const fee = 5000;
  if (lamports <= fee) throw new Error('Nothing left to sweep.');
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: burner.keypair.publicKey, toPubkey: dest, lamports: lamports - fee }));
  tx.feePayer = burner.keypair.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  return await signAndSend({ step, conn, cfg, wallet: burner.wallet, tx, labels: { dry: 'Dry run (sweep)', sign: 'Sign sweep', send: 'Send sweep' } });
}

// Accepts a backup the way people keep it: a JSON array of numbers (the downloaded file) or a base58 private key (what wallets export).
export function burnerFromString(str) {
  const t = String(str || '').trim();
  if (!t) throw new Error('Paste a private key first.');
  if (t[0] === '[') {
    let arr; try { arr = JSON.parse(t); } catch (e) { throw new Error('That backup is not valid JSON.'); }
    if (!Array.isArray(arr) || arr.length !== 64) throw new Error('A backup file holds 64 numbers.');
    return burnerFromSecret(Uint8Array.from(arr));
  }
  let n = 0n;
  for (const ch of t) { const i = B58.indexOf(ch); if (i < 0) throw new Error('That is not a valid private key.'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  let zeros = 0; while (zeros < t.length && t[zeros] === '1') zeros++;
  const bytes = new Uint8Array(zeros + hex.length / 2);
  for (let i = 0; i < hex.length / 2; i++) bytes[zeros + i] = parseInt(hex.substr(i * 2, 2), 16);
  if (bytes.length !== 64) throw new Error('That is not a 64-byte private key.');
  return burnerFromSecret(bytes);
}

// ---------- Meteora (Dynamic Bonding Curve) ----------
// A Meteora coin is a pool made from ONE config that the platform created once (scripts/dbc-config.mjs). The trading fee and
// its split between creator and platform live in that config, so the protocol enforces them on every trade.
const dbc = (conn) => new DynamicBondingCurveClient(conn, 'confirmed');
const fieldsOf = (account) => (account && account.poolState) || account;
const lam = (b) => Number(b.toString()) / LAMPORTS_PER_SOL;

export async function createCoinMeteora({ cluster, wallet, user, name, symbol, uri, devBuySol, dbcConfig }, step) {
  const cfg = config(cluster);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const userKey = new PublicKey(user);
  const configKey = new PublicKey(dbcConfig);
  const mint = Keypair.generate();
  await phase(step, 'Network check', async (done) => {
    await checkNetwork(conn, cfg);
    const sol = (await conn.getBalance(userKey)) / LAMPORTS_PER_SOL, need = 0.05 + (devBuySol || 0);
    if (sol < need) throw new Error('Balance is ' + sol.toFixed(3) + ' SOL. A ' + (devBuySol || 0) + ' SOL first buy plus fees needs about ' + need.toFixed(2) + ' SOL.');
    done('ok', cfg.label + ', balance ' + sol.toFixed(3) + ' SOL');
  });
  const built = await phase(step, 'Build create transaction', async (done) => {
    const client = dbc(conn);
    const createPoolParam = { baseMint: mint.publicKey, config: configKey, name, symbol, uri, payer: userKey, poolCreator: userKey };
    let tx, buyTx = null;
    if (devBuySol && devBuySol > 0) {
      // The pool and the creator's buy go in one transaction, so nobody can buy before the creator.
      const svc = [client.pool, client.creator].find((x) => x && typeof x.createPoolWithFirstBuy === 'function');
      if (!svc) throw new Error('This version of the Meteora SDK cannot do a first buy at launch.');
      const out = await svc.createPoolWithFirstBuy({
        createPoolParam,
        firstBuyParam: { buyer: userKey, receiver: userKey, buyAmount: new BN(Math.round(devBuySol * 1e9)), minimumAmountOut: new BN(0), referralTokenAccount: null }
      });
      tx = out.createPoolTx || out;
      buyTx = out.swapBuyTx || null;
    } else {
      tx = await client.creator.createPool(createPoolParam);
    }
    tx.feePayer = userKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    done('ok', 'Mint ' + mint.publicKey.toBase58(), explorerAddress(cfg, mint.publicKey.toBase58()));
    return { tx, buyTx };
  });
  const signature = await signAndSend({ step, conn, cfg, wallet, tx: built.tx, extraSigner: mint, labels: { dry: 'Dry run', sign: 'Sign', send: 'Send and confirm' } });
  const result = { signature, mint: mint.publicKey.toBase58(), pool: '', buySignature: built.buyTx ? null : signature, buyError: null, atomic: !built.buyTx };
  result.pool = await phase(step, 'Find pool', async (done) => {
    let p = null;
    for (let i = 0; i < 8 && !p; i++) {
      try { p = await dbc(conn).state.getPoolByBaseMint(mint.publicKey); } catch (e) { p = null; }
      if (!p) await wait(1500);
    }
    if (!p) throw new Error('The coin was created but its pool could not be read yet. It is safe; reload the coin page in a minute.');
    const addr = (p.publicKey || p.address).toBase58();
    done('ok', addr.slice(0, 4) + '…' + addr.slice(-4));
    return addr;
  }).catch(() => '');
  if (built.buyTx) {
    try {
      built.buyTx.feePayer = userKey;
      built.buyTx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
      result.buySignature = await signAndSend({ step, conn, cfg, wallet, tx: built.buyTx, labels: { dry: 'Dry run (first buy)', sign: 'Sign first buy', send: 'Send first buy' } });
    } catch (e) { result.buyError = message(e); }
  }
  return result;
}

// Market cap and curve progress of a Meteora pool, read in the browser (the server has no SDK).
export async function meteoraCurve(cluster, poolAddress) {
  const cfg = config(cluster);
  const client = dbc(new Connection(cfg.rpc, 'confirmed'));
  const raw = await client.state.getPool(poolAddress);
  const f = fieldsOf((raw && raw.account) || raw);
  if (!f) throw new Error('No pool');
  const priceSol = getPriceFromSqrtPrice(f.sqrtPrice, TOKEN_DECIMALS, 9).toNumber();
  const progress = await client.state.getPoolQuoteTokenCurveProgress(poolAddress).catch(() => 0);
  return { priceSol, mcSol: priceSol * 1e9, progress: Math.round(progress * 1000) / 10, migrated: f.isMigrated !== 0 };
}

// Fees waiting for a creator, per pool (SOL).
export async function meteoraCreatorFees(cluster, creator) {
  const client = dbc(new Connection(config(cluster).rpc, 'confirmed'));
  const rows = await client.state.getPoolsFeesByCreator(new PublicKey(creator));
  return rows.map((r) => ({ pool: r.poolAddress.toBase58(), raw: r.creatorQuoteFee, sol: lam(r.creatorQuoteFee) }));
}
export async function claimMeteoraCreatorFees({ cluster, wallet, user, pool, raw }, step) {
  const cfg = config(cluster), conn = new Connection(cfg.rpc, 'confirmed'), userKey = new PublicKey(user);
  const tx = await phase(step, 'Build claim', async (done) => {
    const t = await dbc(conn).creator.claimCreatorTradingFee({ creator: userKey, payer: userKey, pool: new PublicKey(pool), maxBaseAmount: new BN(0), maxQuoteAmount: raw });
    t.feePayer = userKey; t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    done('ok', 'Claiming about ' + lam(raw).toFixed(6) + ' SOL');
    return t;
  });
  return await signAndSend({ step, conn, cfg, wallet, tx, labels: { dry: 'Dry run (claim)', sign: 'Sign claim', send: 'Send claim' } });
}

// The platform's share, for the admin page: every pool made from the config, and who may claim.
export async function meteoraPartnerFees(cluster, dbcConfig) {
  const client = dbc(new Connection(config(cluster).rpc, 'confirmed'));
  const key = new PublicKey(dbcConfig);
  const c = await client.state.getPoolConfig(key);
  const cc = (c && c.account) || c;
  const rows = await client.state.getPoolsFeesByConfig(key);
  return { claimer: cc && cc.feeClaimer ? cc.feeClaimer.toBase58() : '', rows: rows.map((r) => ({ pool: r.poolAddress.toBase58(), raw: r.partnerQuoteFee, sol: lam(r.partnerQuoteFee), total: lam(r.totalTradingQuoteFee) })) };
}
export async function claimMeteoraPartnerFees({ cluster, wallet, user, pool, raw }, step) {
  const cfg = config(cluster), conn = new Connection(cfg.rpc, 'confirmed'), userKey = new PublicKey(user);
  const tx = await phase(step, 'Build claim', async (done) => {
    const t = await dbc(conn).partner.claimPartnerTradingFee({ pool: new PublicKey(pool), feeClaimer: userKey, payer: userKey, maxBaseAmount: new BN(0), maxQuoteAmount: raw });
    t.feePayer = userKey; t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    done('ok', 'Claiming about ' + lam(raw).toFixed(6) + ' SOL');
    return t;
  });
  return await signAndSend({ step, conn, cfg, wallet, tx, labels: { dry: 'Dry run (claim)', sign: 'Sign claim', send: 'Send claim' } });
}


// ---------- Raydium LaunchLab ----------
// A LaunchLab coin is a pool made under ONE platform that the platform wallet created once (scripts/launchlab-platform.mjs).
// The platform fee, the creator fee and the split of the graduation liquidity live in that platform account, so the protocol
// enforces them on every trade. The creator's fees collect in one vault per wallet (all of that wallet's coins together).
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const llProgram = (cluster) => (cluster === 'mainnet' ? LAUNCHPAD_PROGRAM : DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM);
const sol9 = (b) => Number(b.toString()) / LAMPORTS_PER_SOL;
const wsolAta = (owner) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), NATIVE_MINT.toBuffer()], ATA_PROGRAM)[0];

// The SDK only builds the transactions here. This site's own wallet flow signs and sends them.
async function raydiumFor(cluster, conn, userKey) {
  const r = await Raydium.load({
    connection: conn, owner: userKey, cluster: cluster === 'mainnet' ? 'mainnet' : 'devnet',
    disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: 'confirmed',
    ...(cluster === 'mainnet' ? {} : { urlConfigs: { ...DEV_API_URLS, BASE_HOST: 'https://api-v3-devnet.raydium.io', OWNER_BASE_HOST: 'https://owner-v1-devnet.raydium.io' } })
  });
  // createLaunchpad asks Raydium's API for default curve numbers. We pass every number ourselves, so skip that call.
  r.api.fetchLaunchConfigs = async () => [];
  return r;
}

// A transaction only wants the new mint's signature if the mint is one of its signers.
function wantsSigner(tx, key) {
  const m = tx.message;
  if (m && m.staticAccountKeys) return m.staticAccountKeys.slice(0, m.header.numRequiredSignatures).some((k) => k.equals(key));
  return (tx.signatures || []).some((s) => s.publicKey && s.publicKey.equals(key));
}

export async function createCoinLaunchLab({ cluster, wallet, user, name, symbol, uri, devBuySol, platform }, step) {
  const cfg = config(cluster);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const userKey = new PublicKey(user);
  const platformId = new PublicKey(platform);
  const programId = llProgram(cluster);
  const mint = Keypair.generate();
  await phase(step, 'Network check', async (done) => {
    await checkNetwork(conn, cfg);
    const sol = (await conn.getBalance(userKey)) / LAMPORTS_PER_SOL, need = 0.06 + (devBuySol || 0);
    if (sol < need) throw new Error('Balance is ' + sol.toFixed(3) + ' SOL. A ' + (devBuySol || 0) + ' SOL first buy plus fees needs about ' + need.toFixed(2) + ' SOL.');
    done('ok', cfg.label + ', balance ' + sol.toFixed(3) + ' SOL');
  });
  const built = await phase(step, 'Build create transaction', async (done) => {
    const raydium = await raydiumFor(cluster, conn, userKey);
    const configId = getPdaLaunchpadConfigId(programId, NATIVE_MINT, 0, 0).publicKey;
    const out = await raydium.launchpad.createLaunchpad({
      programId, platformId, configId, mintA: mint.publicKey, decimals: TOKEN_DECIMALS, mintBDecimals: 9,
      name, symbol, uri, migrateType: 'cpmm', txVersion: TxVersion.V0,
      // The same numbers as pump.fun: 1B supply, 793.1M sold on the curve, 85 SOL raised before it graduates.
      supply: new BN('1000000000000000'), totalSellA: new BN('793100000000000'), totalFundRaisingB: new BN('85000000000'),
      createOnly: !(devBuySol && devBuySol > 0),
      buyAmount: new BN(Math.round((devBuySol || 0) * 1e9)), slippage: new BN(300),
      extraSigners: [mint]
    });
    const txs = out.transactions || (out.transaction ? [out.transaction] : []);
    if (!txs.length) throw new Error('The Raydium SDK built no transaction.');
    done('ok', 'Mint ' + mint.publicKey.toBase58(), explorerAddress(cfg, mint.publicKey.toBase58()));
    return { txs, poolId: out.extInfo && out.extInfo.address && out.extInfo.address.poolId };
  });
  let signature = '';
  for (let i = 0; i < built.txs.length; i++) {
    const tx = built.txs[i], tag = built.txs.length > 1 ? ' (' + (i + 1) + ' of ' + built.txs.length + ')' : '';
    const creates = wantsSigner(tx, mint.publicKey);
    const sig = await signAndSend({ step, conn, cfg, wallet, tx, extraSigner: creates ? mint : null, labels: { dry: 'Dry run' + tag, sign: 'Sign' + tag, send: 'Send and confirm' + tag } });
    // The transaction the mint signed is the one that creates the coin, so that is the one the server checks.
    if (creates && !signature) signature = sig;
  }
  const pool = built.poolId ? built.poolId.toBase58() : getPdaLaunchpadPoolId(programId, mint.publicKey, NATIVE_MINT).publicKey.toBase58();
  return { signature, mint: mint.publicKey.toBase58(), pool, buySignature: signature, buyError: null, atomic: built.txs.length === 1 };
}

// Market cap and curve progress of a LaunchLab pool, read in the browser.
export async function launchlabCurve(cluster, poolAddress) {
  const conn = new Connection(config(cluster).rpc, 'confirmed');
  const info = await conn.getAccountInfo(new PublicKey(poolAddress));
  if (!info) throw new Error('No pool');
  const p = LaunchpadPool.decode(info.data);
  const priceSol = (Number(p.virtualB.add(p.realB).toString()) / Number(p.virtualA.sub(p.realA).toString())) * Math.pow(10, p.mintDecimalsA - p.mintDecimalsB);
  const progress = Number(p.realB.toString()) / Number(p.totalFundRaisingB.toString());
  return { priceSol, mcSol: priceSol * (Number(p.supply.toString()) / Math.pow(10, p.mintDecimalsA)), progress: Math.round(progress * 1000) / 10, migrated: p.status !== 0, raisedSol: sol9(p.realB), targetSol: sol9(p.totalFundRaisingB) };
}

// Turns the wrapped SOL that a claim pays out into plain SOL. Raydium pays fees as wrapped SOL, so the claim is followed by this.
async function unwrapWsol({ step, conn, cfg, wallet, userKey }) {
  const ata = wsolAta(userKey);
  const info = await conn.getAccountInfo(ata);
  if (!info) return null;
  const tx = new Transaction().add(new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: ata, isSigner: false, isWritable: true }, { pubkey: userKey, isSigner: false, isWritable: true }, { pubkey: userKey, isSigner: true, isWritable: false }], data: Buffer.from([9]) }));
  tx.feePayer = userKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  return await signAndSend({ step, conn, cfg, wallet, tx, labels: { dry: 'Dry run (unwrap)', sign: 'Sign unwrap', send: 'Unwrap to SOL' } });
}

// SOL waiting in a wallet's LaunchLab creator vault, in SOL (all of that wallet's coins together).
export async function launchlabCreatorFees(cluster, creator) {
  const conn = new Connection(config(cluster).rpc, 'confirmed');
  const vault = getPdaCreatorVault(llProgram(cluster), new PublicKey(creator), NATIVE_MINT).publicKey;
  try { const b = await conn.getTokenAccountBalance(vault); return Number(b.value.amount) / LAMPORTS_PER_SOL; } catch (e) { return 0; }
}
export async function claimLaunchlabCreatorFees({ cluster, wallet, user }, step) {
  const cfg = config(cluster), conn = new Connection(cfg.rpc, 'confirmed'), userKey = new PublicKey(user);
  const tx = await phase(step, 'Build claim', async (done) => {
    const raydium = await raydiumFor(cluster, conn, userKey);
    const out = await raydium.launchpad.claimCreatorFee({ programId: llProgram(cluster), mintB: NATIVE_MINT, txVersion: TxVersion.V0 });
    done('ok', 'Claiming your LaunchLab creator fees');
    return out.transaction;
  });
  const sig = await signAndSend({ step, conn, cfg, wallet, tx, labels: { dry: 'Dry run (claim)', sign: 'Sign claim', send: 'Send claim' } });
  await unwrapWsol({ step, conn, cfg, wallet, userKey }).catch(() => null);
  return sig;
}

// The platform's share, for the admin page. Raydium pays every LaunchLab trade's platform fee into one vault for the platform.
export async function launchlabPlatformFees(cluster, platform) {
  const conn = new Connection(config(cluster).rpc, 'confirmed');
  const platformId = new PublicKey(platform);
  const pinfo = await conn.getAccountInfo(platformId);
  let claimer = '';
  if (pinfo) { try { claimer = PlatformConfig.decode(pinfo.data).platformClaimFeeWallet.toBase58(); } catch (e) { claimer = ''; } }
  const vault = getPdaPlatformVault(llProgram(cluster), platformId, NATIVE_MINT).publicKey;
  let sol = 0;
  try { sol = Number((await conn.getTokenAccountBalance(vault)).value.amount) / LAMPORTS_PER_SOL; } catch (e) { sol = 0; }
  return { claimer, sol };
}
export async function claimLaunchlabPlatformFees({ cluster, wallet, user, platform }, step) {
  const cfg = config(cluster), conn = new Connection(cfg.rpc, 'confirmed'), userKey = new PublicKey(user);
  const tx = await phase(step, 'Build claim', async (done) => {
    const raydium = await raydiumFor(cluster, conn, userKey);
    const out = await raydium.launchpad.claimVaultPlatformFee({ programId: llProgram(cluster), platformId: new PublicKey(platform), mintB: NATIVE_MINT, claimFeeWallet: userKey, txVersion: TxVersion.V0 });
    done('ok', 'Claiming the platform fees');
    return out.transaction;
  });
  const sig = await signAndSend({ step, conn, cfg, wallet, tx, labels: { dry: 'Dry run (claim)', sign: 'Sign claim', send: 'Send claim' } });
  await unwrapWsol({ step, conn, cfg, wallet, userKey }).catch(() => null);
  return sig;
}

// ---------- Test trading (devnet) ----------
// Buy and sell on a Meteora or LaunchLab coin from this site, so fees can be generated and claimed while testing.
const ataOf = (owner, mint) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

// A wallet's balance of one coin: raw base units (as text) and whole tokens.
export async function tokenBalance(cluster, owner, mint) {
  const conn = new Connection(config(cluster).rpc, 'confirmed');
  try {
    const b = await conn.getTokenAccountBalance(ataOf(new PublicKey(owner), new PublicKey(mint)));
    return { raw: b.value.amount, ui: Number(b.value.amount) / Math.pow(10, TOKEN_DECIMALS) };
  } catch (e) { return { raw: '0', ui: 0 }; }
}

// side is 'buy' (amountSol of SOL) or 'sell' (sellPct percent of the wallet's balance of the coin).
export async function tradeCoin({ cluster, wallet, user, venue, mint, pool, side, amountSol, sellPct, platform }, step) {
  const cfg = config(cluster);
  const conn = new Connection(cfg.rpc, 'confirmed');
  const userKey = new PublicKey(user), mintKey = new PublicKey(mint);
  if (side !== 'buy' && side !== 'sell') throw new Error('Choose buy or sell.');
  let amountIn;
  await phase(step, 'Check balances', async (done) => {
    await checkNetwork(conn, cfg);
    const sol = (await conn.getBalance(userKey)) / LAMPORTS_PER_SOL;
    if (side === 'buy') {
      if (!(amountSol > 0)) throw new Error('Enter an amount of SOL to spend.');
      if (sol < amountSol + 0.01) throw new Error('Balance is ' + sol.toFixed(3) + ' SOL. That buy plus fees needs about ' + (amountSol + 0.01).toFixed(3) + ' SOL.');
      amountIn = new BN(Math.round(amountSol * 1e9));
      done('ok', 'Spending ' + amountSol + ' SOL of ' + sol.toFixed(3));
    } else {
      const bal = await tokenBalance(cluster, user, mint);
      if (!(Number(bal.raw) > 0)) throw new Error('This wallet holds none of this coin.');
      if (sol < 0.005) throw new Error('Balance is ' + sol.toFixed(4) + ' SOL, which is not enough for the network fee.');
      amountIn = new BN(bal.raw).muln(Math.max(1, Math.min(100, Math.round(sellPct || 100)))).divn(100);
      done('ok', 'Selling ' + (Number(amountIn.toString()) / Math.pow(10, TOKEN_DECIMALS)).toLocaleString() + ' tokens');
    }
  });
  const tx = await phase(step, 'Build ' + side + ' transaction', async (done) => {
    let t;
    if (venue === 'meteora') {
      t = await dbc(conn).pool.swap({ amountIn, minimumAmountOut: new BN(0), swapBaseForQuote: side === 'sell', owner: userKey, pool: new PublicKey(pool), referralTokenAccount: null });
      t.feePayer = userKey; t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    } else if (venue === 'raydium') {
      const raydium = await raydiumFor(cluster, conn, userKey);
      await raydium.account.fetchWalletTokenAccounts().catch(() => null);
      const common = { programId: llProgram(cluster), mintA: mintKey, slippage: new BN(500), txVersion: TxVersion.V0 };
      const out = side === 'buy' ? await raydium.launchpad.buyToken({ ...common, buyAmount: amountIn }) : await raydium.launchpad.sellToken({ ...common, sellAmount: amountIn });
      t = out.transaction;
    } else throw new Error('Trading here is only for Meteora and Raydium LaunchLab coins. pump.fun coins trade on pump.fun.');
    done('ok', side === 'buy' ? 'Buy with up to 5% slippage' : 'Sell with up to 5% slippage');
    return t;
  });
  return await signAndSend({ step, conn, cfg, wallet, tx, labels: { dry: 'Dry run (' + side + ')', sign: 'Sign ' + side, send: 'Send ' + side } });
}
