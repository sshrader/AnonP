// One-time setup: creates the BurnPad bonding-curve config on Meteora. Every Meteora coin launched here is a pool made
// from this config, so these numbers set the curve shape and the fees. On mainnet they are permanent.
//
//   node --env-file=.env scripts/dbc-config.mjs --check     print the settings and send nothing
//   node --env-file=.env scripts/dbc-config.mjs             create it (devnet by default)
//   ... add --confirm-mainnet to create it on mainnet
//
// Settings (all optional). Market caps are in SOL, not dollars.
//   DBC_INITIAL_MC=30      market cap when a coin starts            (pump.fun starts near 30 SOL)
//   DBC_MIGRATION_MC=410   market cap when the curve is full         (pump.fun: about 85 SOL of buys fill it)
//   DBC_FEE_BPS=100        trading fee, 100 = 1% (pump.fun charges about 1%). Meteora's minimum is 25.
//   DBC_CREATOR_FEE_PCT=90 share of the fee, after Meteora's 20% cut, that goes to the coin's creator (0 to 100).
//                          The rest is yours (the fee claimer).
//   DBC_FEE_CLAIMER=<address>  the ONLY wallet that can ever claim your share. Use a hardware wallet or multisig on mainnet.
//   PARTNER_KEYPAIR=<file>     JSON key file of the wallet that pays for creating the config (keep it outside the repo).
//   SOLANA_RPC_URL=<url>       RPC to use (default: public devnet)
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, clusterApiUrl } from '@solana/web3.js';
import {
  ActivationType, BaseFeeMode, CollectFeeMode, DammV2DynamicFeeMode, DynamicBondingCurveClient, MigratedCollectFeeMode,
  MigrationFeeOption, MigrationOption, TokenAuthorityOption, TokenDecimal, TokenType, buildCurveWithMarketCap,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const checkOnly = process.argv.includes('--check');
const num = (name, fallback) => (process.env[name] ? Number(process.env[name]) : fallback);
const initialMC = num('DBC_INITIAL_MC', 30);
const migrationMC = num('DBC_MIGRATION_MC', 410);
const feeBps = num('DBC_FEE_BPS', 100);
const creatorFeePct = num('DBC_CREATOR_FEE_PCT', 90);
if (!(initialMC > 0) || !(migrationMC > initialMC)) throw new Error('DBC_MIGRATION_MC must be larger than DBC_INITIAL_MC.');
if (feeBps < 25) throw new Error('DBC_FEE_BPS must be at least 25 (Meteora minimum).');
if (!(creatorFeePct >= 0 && creatorFeePct <= 100)) throw new Error('DBC_CREATOR_FEE_PCT must be 0 to 100.');

const curve = buildCurveWithMarketCap({
  token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: {
    baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 } },
    dynamicFeeEnabled: true, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: creatorFeePct, poolCreationFee: 0, enableFirstSwapWithMinFee: true,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.Customizable, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Enabled, poolFeeBps: 100 },
  },
  // All liquidity that graduates to the DEX is locked for good, so nobody, including you, can pull it.
  liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp, initialMarketCap: initialMC, migrationMarketCap: migrationMC,
});

const fill = curve.migrationQuoteThreshold;
console.log('\nCurve settings');
console.log(`  starts at      ${initialMC} SOL market cap`);
console.log(`  graduates at   ${migrationMC} SOL market cap`);
if (fill) console.log(`  to fill it     about ${(Number(fill.toString()) / LAMPORTS_PER_SOL).toFixed(2)} SOL of buys (pump.fun is about 85). Raise or lower DBC_MIGRATION_MC to tune this.`);
console.log(`  trading fee    ${(feeBps / 100).toFixed(2)}% per trade. Meteora keeps 20% of it; of the rest, ${creatorFeePct}% goes to the creator and ${100 - creatorFeePct}% to you.`);
console.log(`  a creator earns about ${((feeBps / 100) * 0.8 * (creatorFeePct / 100)).toFixed(3)}% of every trade; you earn about ${((feeBps / 100) * 0.8 * (1 - creatorFeePct / 100)).toFixed(3)}%`);
console.log('  supply         1,000,000,000 (6 decimals), plain SPL token');
console.log('  after graduating: liquidity moves to a DAMM v2 pool and is locked permanently');
if (checkOnly) { console.log('\n--check: nothing was sent.'); process.exit(0); }

const keyFile = path.resolve(process.env.PARTNER_KEYPAIR || '.devnet-keypair.json');
if (!fs.existsSync(keyFile)) throw new Error(`No wallet file at ${keyFile}. Set PARTNER_KEYPAIR to a JSON key file of the wallet that pays for this.`);
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, 'utf8'))));
const connection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl('devnet'), 'confirmed');
const mainnet = (await connection.getGenesisHash()) === MAINNET_GENESIS;
console.log(`\nNetwork: ${mainnet ? 'MAINNET (real money, permanent)' : 'devnet or testnet'}`);
const balance = await connection.getBalance(payer.publicKey);
console.log(`Deployer ${payer.publicKey.toBase58()} (${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL)`);
if (balance < 0.05 * LAMPORTS_PER_SOL) throw new Error('Fund the deployer with at least 0.05 SOL first.');
const claimer = process.env.DBC_FEE_CLAIMER ? new PublicKey(process.env.DBC_FEE_CLAIMER.trim()) : payer.publicKey;
console.log(`Fee claimer (the only wallet that can ever claim your share, set forever): ${claimer.toBase58()}`);
if (mainnet && claimer.equals(payer.publicKey)) console.log('WARNING: the claimer is the key file on this machine. Set DBC_FEE_CLAIMER to a hardware wallet or multisig address.');
if (mainnet && !process.argv.includes('--confirm-mainnet')) throw new Error('Creating the config on MAINNET is permanent. Re-run with --confirm-mainnet once you have checked the settings above.');

const config = Keypair.generate();
const client = new DynamicBondingCurveClient(connection, 'confirmed');
const tx = await client.partner.createConfig({ config: config.publicKey, feeClaimer: claimer, leftoverReceiver: claimer, payer: payer.publicKey, quoteMint: WSOL, ...curve });
const latest = await connection.getLatestBlockhash('confirmed');
tx.feePayer = payer.publicKey; tx.recentBlockhash = latest.blockhash; tx.sign(payer, config);
const sig = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
console.log(`\nConfig created. Transaction: ${sig}\n\nAdd these to the server's environment (Railway variables), then redeploy:\n`);
console.log(`DBC_CONFIG=${config.publicKey.toBase58()}`);
console.log(`DBC_FEE_BPS=${feeBps}`);
console.log(`DBC_CREATOR_FEE_PCT=${creatorFeePct}`);
console.log(`\nThe last two only change the numbers shown on the site. The real values are in the config.\nYour share can only be claimed by ${claimer.toBase58()}, from the /admin page.`);
