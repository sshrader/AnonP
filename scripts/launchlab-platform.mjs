// One-time setup: creates the BurnPad platform on Raydium LaunchLab. Every LaunchLab coin launched here is made under this
// platform, so these numbers set the platform fee, the creator fee and who receives the graduation liquidity.
//
//   node --env-file=.env scripts/launchlab-platform.mjs --check     print the settings and send nothing
//   node --env-file=.env scripts/launchlab-platform.mjs             create it (devnet by default)
//   ... add --confirm-mainnet to create it on mainnet
//
// Each wallet can create ONE platform, so the wallet in PARTNER_KEYPAIR becomes the platform admin for good.
// Rates are percentages of each trade. Raydium adds its own 0.25% on top, which nobody can change.
//   LAUNCHLAB_FEE_PCT=0.25         your platform fee (yours to claim)
//   LAUNCHLAB_CREATOR_PCT=0.5      the creator's fee (Raydium allows up to 5)
//   LAUNCHLAB_FEE_CLAIMER=<addr>   the wallet that receives and claims your fees (default: the key file's wallet)
//   LAUNCHLAB_LP_PLATFORM_PCT=0    share of the graduation liquidity (LP) locked for the platform wallet
//   LAUNCHLAB_LP_CREATOR_PCT=0     share locked for the creator. Whatever is left over is burned, so nobody can pull it.
//   LAUNCHLAB_NAME / LAUNCHLAB_WEB / LAUNCHLAB_IMG   how the platform is described on Raydium
//   LAUNCHLAB_CP_CONFIG=<addr>     the CPMM fee tier for the graduated pool (default: Raydium's first one)
//   PARTNER_KEYPAIR=<file>         JSON key file of the platform admin wallet (keep it outside the repo)
//   SOLANA_RPC_URL=<url>           RPC to use (default: public devnet)
import fs from 'node:fs';
import path from 'node:path';
import BN from 'bn.js';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { DEV_API_URLS, DEVNET_PROGRAM_ID, LAUNCHPAD_PROGRAM, Raydium, TxVersion, getPdaPlatformId } from '@raydium-io/raydium-sdk-v2';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const checkOnly = process.argv.includes('--check');
const num = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : fallback);
const feePct = num('LAUNCHLAB_FEE_PCT', 0.25);
const creatorPct = num('LAUNCHLAB_CREATOR_PCT', 0.5);
const lpPlatform = num('LAUNCHLAB_LP_PLATFORM_PCT', 0);
const lpCreator = num('LAUNCHLAB_LP_CREATOR_PCT', 0);
if (!(feePct >= 0 && feePct < 100)) throw new Error('LAUNCHLAB_FEE_PCT must be 0 or more.');
if (!(creatorPct >= 0 && creatorPct <= 5)) throw new Error('LAUNCHLAB_CREATOR_PCT must be 0 to 5 (Raydium\'s limit).');
if (!(lpPlatform >= 0 && lpCreator >= 0 && lpPlatform + lpCreator <= 100)) throw new Error('The LP shares must be 0 or more and add up to 100 or less.');
// Raydium counts rates out of 1,000,000, so 1% is 10,000.
const rate = (pct) => new BN(Math.round(pct * 10000));
const scale = (pct) => Math.round(pct * 10000);
const burnScale = 1_000_000 - scale(lpPlatform) - scale(lpCreator);

console.log('\nLaunchLab platform settings');
console.log(`  your fee        ${feePct}% of every trade (you claim it)`);
console.log(`  creator fee     ${creatorPct}% of every trade (the coin's creator claims it)`);
console.log(`  Raydium's fee   0.25% on top (fixed by Raydium)`);
console.log(`  a trader pays   about ${(feePct + creatorPct + 0.25).toFixed(2)}% in total (pump.fun charges 1.25%)`);
console.log(`  graduation LP   ${lpPlatform}% locked for you, ${lpCreator}% locked for the creator, ${(burnScale / 10000).toFixed(2)}% burned`);
console.log('  coins           1,000,000,000 supply, 793.1M sold on the curve, 85 SOL raised before it graduates (the same as pump.fun)');
if (checkOnly) { console.log('\n--check: nothing was sent.'); process.exit(0); }

const keyFile = path.resolve(process.env.PARTNER_KEYPAIR || '.devnet-keypair.json');
if (!fs.existsSync(keyFile)) throw new Error(`No wallet file at ${keyFile}. Set PARTNER_KEYPAIR to a JSON key file of the platform admin wallet.`);
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, 'utf8'))));
const connection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl('devnet'), 'confirmed');
const mainnet = (await connection.getGenesisHash()) === MAINNET_GENESIS;
console.log(`\nNetwork: ${mainnet ? 'MAINNET (real money)' : 'devnet or testnet'}`);
const balance = await connection.getBalance(admin.publicKey);
console.log(`Platform admin ${admin.publicKey.toBase58()} (${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL)`);
if (balance < 0.05 * LAMPORTS_PER_SOL) throw new Error('Fund the admin wallet with at least 0.05 SOL first.');
const claimer = process.env.LAUNCHLAB_FEE_CLAIMER ? new PublicKey(process.env.LAUNCHLAB_FEE_CLAIMER.trim()) : admin.publicKey;
console.log(`Fee wallet (receives and claims your fees): ${claimer.toBase58()}`);
if (mainnet && claimer.equals(admin.publicKey)) console.log('WARNING: the fee wallet is the key file on this machine. Consider a hardware wallet or multisig address in LAUNCHLAB_FEE_CLAIMER.');
if (mainnet && !process.argv.includes('--confirm-mainnet')) throw new Error('Creating the platform on MAINNET costs real SOL and is tied to this admin wallet. Re-run with --confirm-mainnet once you have checked the settings above.');

const programId = mainnet ? LAUNCHPAD_PROGRAM : DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM;
const platformId = getPdaPlatformId(programId, admin.publicKey).publicKey;
if (await connection.getAccountInfo(platformId)) {
  console.log(`\nThis admin wallet already has a platform: ${platformId.toBase58()}\nSet LAUNCHLAB_PLATFORM=${platformId.toBase58()} on the server. (Each wallet can have only one. Use another wallet for a new one.)`);
  process.exit(0);
}

// The fee tier of the pool that a coin graduates into.
let cpConfig = process.env.LAUNCHLAB_CP_CONFIG && process.env.LAUNCHLAB_CP_CONFIG.trim();
if (!cpConfig) {
  const host = mainnet ? 'https://api-v3.raydium.io' : 'https://api-v3-devnet.raydium.io';
  const res = await (await fetch(host + '/main/cpmm-config')).json();
  const list = Array.isArray(res && res.data) ? res.data : [];
  const pick = list.find((c) => c.index === 0) || list[0];
  if (!pick) throw new Error('Could not read Raydium\'s CPMM configs. Set LAUNCHLAB_CP_CONFIG to one by hand.');
  cpConfig = pick.id;
}
console.log(`Graduated pool fee tier (CPMM config): ${cpConfig}`);

const raydium = await Raydium.load({
  connection, owner: admin, cluster: mainnet ? 'mainnet' : 'devnet', disableFeatureCheck: true, disableLoadToken: true,
  ...(mainnet ? {} : { urlConfigs: { ...DEV_API_URLS, BASE_HOST: 'https://api-v3-devnet.raydium.io', OWNER_BASE_HOST: 'https://owner-v1-devnet.raydium.io' } })
});
const { execute, extInfo } = await raydium.launchpad.createPlatformConfig({
  programId, platformAdmin: admin.publicKey, platformClaimFeeWallet: claimer, platformLockNftWallet: claimer,
  platformVestingWallet: PublicKey.default, cpConfigId: new PublicKey(cpConfig), transferFeeExtensionAuth: admin.publicKey,
  creatorFeeRate: rate(creatorPct), feeRate: rate(feePct),
  migrateCpLockNftScale: { platformScale: new BN(scale(lpPlatform)), creatorScale: new BN(scale(lpCreator)), burnScale: new BN(burnScale) },
  name: process.env.LAUNCHLAB_NAME || 'BurnPad', web: process.env.LAUNCHLAB_WEB || process.env.PUBLIC_URL || 'https://burnerpad.xyz', img: process.env.LAUNCHLAB_IMG || (process.env.PUBLIC_URL || 'https://burnerpad.xyz') + '/favicon.svg',
  txVersion: TxVersion.V0
});
const sent = await execute({ sendAndConfirm: true });
console.log(`\nPlatform created. Transaction: ${sent.txId || JSON.stringify(sent)}\n\nAdd these to the server's environment (Railway variables), then redeploy:\n`);
console.log(`LAUNCHLAB_PLATFORM=${extInfo.platformId.toBase58()}`);
console.log(`LAUNCHLAB_FEE_PCT=${feePct}`);
console.log(`LAUNCHLAB_CREATOR_PCT=${creatorPct}`);
console.log(`\nThe last two only change the numbers shown on the site. The real rates are in the platform account.\nYour fees can only be claimed by ${claimer.toBase58()}, from the /admin page.`);
