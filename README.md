# BurnerPad

A non-custodial token launcher. Launch from a **fresh one-time wallet** that your browser creates and you fund yourself.

- **No pool, no custody.** BurnerPad never holds funds and never sees a private key. The burner's key is generated in the browser and stays there.
- **Multi-venue.** pump.fun is live. Meteora and Raydium LaunchLab are listed as "soon" until their SDKs are integrated and tested.
- **Clear fee.** A platform share of creator fees is set by a fee-split transaction the creator signs. It is shown before launch and on the coin page. Nothing is taken from your buy.
- **Public trust checks** on every coin page: mint and freeze authority, creator holdings, top-10 concentration, launch-block buyers. They describe what is on-chain; they are not a safety rating.

## What it does not do

BurnerPad separates the *launch wallet* from your main wallet. It does **not** hide where the money came from. If you fund the burner directly from your main wallet, that link is visible on-chain, and so is sweeping leftovers or fees back to it. For real separation, fund the burner from an account that is not tied to you. There is deliberately no shielded or pooled deposit/withdraw feature.

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
| `BLOCKED_WORDS` | Extra comma-separated words to reject in names and descriptions. |

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

Server, pages and tests pass locally. The browser bundle, the on-chain launch, the fee split and the sweep have not been run against a live network from the development sandbox. Run a devnet launch before mainnet.
