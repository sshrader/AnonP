// Makes a new Solana key file and prints its address.  node scripts/new-keypair.mjs ../partner-devnet.json
// Keep the file OUTSIDE this repo. It will not overwrite an existing file.
import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

const out = process.argv[2];
if (!out) throw new Error('Usage: node scripts/new-keypair.mjs <file to create, outside the repo>');
const file = path.resolve(out);
if (fs.existsSync(file)) throw new Error(`${file} already exists. Pick another name so nothing is overwritten.`);
const kp = Keypair.generate();
fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
console.log(`Created ${file}\nAddress: ${kp.publicKey.toBase58()}\nSend this address a little SOL, and never share or commit the file.`);
