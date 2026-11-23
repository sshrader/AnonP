# BurnPad

A non-custodial token launcher. Launch from a **fresh one-time wallet** that your browser creates and you fund yourself.

- **No pool, no custody.** BurnPad never holds funds and never sees a private key. The burner's key is generated in the browser and stays there.
- **Multi-venue.** pump.fun is live. Meteora (Dynamic Bonding Curve) goes live once you create its curve config and set `DBC_CONFIG`. Raydium LaunchLab goes live once you create its platform and set `LAUNCHLAB_PLATFORM`.
- **Clear fee.** A platform share of creator fees is set by a fee-split transaction the creator signs. It is shown before launch and on the coin page. Nothing is taken from your buy.
- **Public trust checks** on every coin page: mint and freeze authority, creator holdings, top-10 concentration, launch-block buyers. They describe what is on-chain; they are not a safety rating.

## What it does not do

BurnPad separates the *launch wallet* from your main wallet. It does **not** hide where the money came from. If you fund the burner directly from your main wallet, that link is visible on-chain, and so is sweeping leftovers or fees back to it. For real separation, fund the burner from an account that is not tied to you. There is deliberately no shielded or pooled deposit/withdraw feature.

## Run

```
npm install
npm run build     # bundles src/launch.mjs to dist/launch.js
npm start
npm test
```

Defaults to devnet. Set `CLUSTER=mainnet` and `RPC_URL` for mainnet. Test on devnet first, then with a small mainnet launch.

## Environment

| Variable | Purpose |
|---|---|
| `CLUSTER` | `mainnet` or unset (devnet). |
| `RPC_URL` | Mainnet RPC. Kept on the server; the browser uses `/api/rpc/mainnet`. |
| `DEVNET_RPC_URL` | Optional private devnet RPC. |
| `PLATFORM_WALLET` | Address that receives the platform share. No wallet means no fee. |
| `PLATFORM_BPS` | Platform share of creator fees in basis points. Default 100 (1%), capped at 1000. |
| `PUBLIC_URL` | Public origin, used in metadata links. |
| `DATA_DIR` | Where metadata, images and the launch list are stored (use a volume). |
| `ADMIN_TOKEN` | Turns on `/admin` (platform fees overview and payouts). Use a long random value. Without it the page and its API are off. |
| `LAUNCHLAB_PLATFORM` | Address of the Raydium LaunchLab platform (printed by `npm run launchlab-platform`). Setting it turns the Raydium venue on. `LAUNCHLAB_FEE_PCT` and `LAUNCHLAB_CREATOR_PCT` (default 0.25 and 0.5) only change the numbers shown on the site. |
| `DBC_CONFIG` | Address of the Meteora curve config (printed by `npm run dbc-config`). Setting it turns the Meteora venue on. |
| `DBC_FEE_BPS`, `DBC_CREATOR_FEE_PCT` | Display only: the trading fee and the creator's share, shown on the launch page. The real values are in the on-chain config. |
| `BLOCKED_WORDS` | Extra comma-separated words to reject in names and descriptions. |

## Meteora setup

1. Make a key file for a throwaway deployer wallet (keep it outside the repo) and fund it with a little SOL. On mainnet also pick a hardware wallet or multisig address to be the **fee claimer**.
2. Look at the numbers first: `PARTNER_KEYPAIR=... npm run dbc-config -- --check`. Defaults mimic pump.fun: starts at a 30 SOL market cap, graduates at 410 SOL (about 85 SOL of buys fills it), 1% trading fee. Tune with `DBC_INITIAL_MC`, `DBC_MIGRATION_MC`, `DBC_FEE_BPS`, `DBC_CREATOR_FEE_PCT` (creator share of the fee after Meteora's 20% cut; default 90).
3. Create it: `npm run dbc-config` (devnet), or add `--confirm-mainnet`. **On mainnet the config is permanent.**
4. Set `DBC_CONFIG` (and the display values it prints) on the server and redeploy.

Fees on Meteora coins are built into the config, so there is no fee-split transaction. Creators claim theirs on the Claim fees page; the platform claims its share on `/admin` with the fee claimer wallet.

## Raydium LaunchLab setup

LaunchLab coins are made under one platform account that your wallet creates once. The platform account holds your fee, the creator fee and what happens to the graduation liquidity, so the protocol enforces them on every trade.

1. Use a wallet key file outside the repo as `PARTNER_KEYPAIR` (it becomes the platform admin for good; each wallet can have one platform) and fund it with devnet SOL. Set `SOLANA_RPC_URL`.
2. Look at the numbers: `npm run launchlab-platform -- --check`. Defaults: 0.25% platform fee, 0.5% creator fee, plus Raydium's own fixed 0.25% (about 1.0% in total, pump.fun charges 1.25%). Tune with `LAUNCHLAB_FEE_PCT`, `LAUNCHLAB_CREATOR_PCT` (Raydium allows up to 5), `LAUNCHLAB_FEE_CLAIMER`, `LAUNCHLAB_LP_PLATFORM_PCT` and `LAUNCHLAB_LP_CREATOR_PCT` (the rest of the graduation liquidity is burned).
3. Create it: `npm run launchlab-platform` (devnet). On mainnet add `--confirm-mainnet`.
4. Set `LAUNCHLAB_PLATFORM` (and the display values it prints) on the server and redeploy.

Coins use pump.fun's numbers: 1B supply, 793.1M sold on the curve, 85 SOL raised before graduating to a Raydium CPMM pool. Creators' fees collect in one vault per wallet (all of that wallet's coins together). They claim it on the Claim fees page, and the platform claims its share on `/admin` with the fee wallet. Raydium pays fees out as wrapped SOL, so each claim is followed by an unwrap step.

## Claim fees and admin

- `#claim` (Claim fees): load the launching wallet from this browser, a pasted key or a connected wallet. It lists that wallet's coins, shows fees waiting, and pays them out. Payouts land as SOL in the launching wallet; use Sweep to move them.
- `/admin`: enter `ADMIN_TOKEN` to see every launch, the platform share signed for each, fees waiting in each coin, and the platform wallet balance. Connect any wallet to pay out coins; it only pays the network fee.

## Layout

- `server.js` metadata, RPC relay, launch verification, listings, coin API
- `trust.js` the coin-page checks
- `chain.js` read-only on-chain reads
- `src/launch.mjs` browser launch code, including burner helpers (`newBurner`, `burnerFromSecret`, `sweep`)
- `index.html`, `coin.html`, `app.css` the pages

## Status

Server, pages and tests pass locally. The browser bundle, the on-chain launches (pump.fun, Meteora and Raydium LaunchLab), the fee split, the Meteora and LaunchLab fee claims and the sweep have not been run against a live network from the development sandbox. Run a devnet launch before mainnet.
