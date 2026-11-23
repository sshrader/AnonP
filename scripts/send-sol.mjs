// Sends SOL from a key file to an address you choose. Dry run by default; add --send to actually send.
//   node scripts/send-sol.mjs <key file> <destination> <amount|ALL> [--send]
// Set SOLANA_RPC_URL to your RPC (default: public mainnet). Keep the key file OUTSIDE this repo.
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

const [keyArg, destArg, amtArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const send = process.argv.includes('--send');
if (!keyArg || !destArg || !amtArg) throw new Error('Usage: node scripts/send-sol.mjs <key file> <destination> <amount|ALL> [--send]');
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(keyArg), 'utf8'))));
const dest = new PublicKey(destArg.trim());
const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const fee = 5000;
const balance = await conn.getBalance(kp.publicKey);
const lamports = amtArg.toUpperCase() === 'ALL' ? balance - fee : Math.round(Number(amtArg) * LAMPORTS_PER_SOL);
if (!(lamports > 0) || lamports + fee > balance) throw new Error(`Not enough SOL. Balance is ${(balance / LAMPORTS_PER_SOL).toFixed(6)}.`);
console.log(`From ${kp.publicKey.toBase58()} (${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL)\nTo   ${dest.toBase58()}\nSend ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (+ about 0.000005 fee)`);
if (!send) { console.log('\nDry run: nothing was sent. Add --send to send it.'); process.exit(0); }
const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports }));
const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
console.log('\nSent. Transaction: ' + sig);
