'use strict';
// Plain-language checks for a coin, computed only from public chain data. No scores, no verdicts: each check says what it saw.
// status: ok | warn | bad | unknown
function trustChecks(oc, rec) {
  oc = oc || {};
  const out = [];
  const add = (id, label, status, detail) => out.push({ id, label, status, detail });
  const fmt = (n) => (Math.round(n * 10) / 10) + '%';

  if (oc.authority) {
    add('mint', 'Mint authority', oc.authority.mint ? 'bad' : 'ok', oc.authority.mint ? 'Someone can still create more of this token.' : 'Revoked. No more tokens can be created.');
    add('freeze', 'Freeze authority', oc.authority.freeze ? 'bad' : 'ok', oc.authority.freeze ? 'Someone can still freeze holders\' tokens.' : 'Revoked. Nobody can freeze holders.');
  } else {
    add('mint', 'Mint authority', 'unknown', 'Could not be read right now.');
    add('freeze', 'Freeze authority', 'unknown', 'Could not be read right now.');
  }

  if (oc.devHoldPct == null) add('dev', 'Creator holds', 'unknown', 'Could not be read right now.');
  else add('dev', 'Creator holds', oc.devHoldPct <= 10 ? 'ok' : oc.devHoldPct <= 20 ? 'warn' : 'bad', fmt(oc.devHoldPct) + ' of supply in the launching wallet.');

  if (oc.top10Pct == null) add('top10', 'Top 10 holders', 'unknown', 'Could not be read right now.');
  else add('top10', 'Top 10 holders', oc.top10Pct <= 30 ? 'ok' : oc.top10Pct <= 50 ? 'warn' : 'bad', fmt(oc.top10Pct) + ' of supply, not counting the bonding curve.');

  const l = oc.launch;
  if (!l) add('bundle', 'Launch-block buyers', 'unknown', 'Could not be read right now.');
  else if (l.capped) add('bundle', 'Launch-block buyers', 'unknown', 'This coin has too much history to scan.');
  else if (!l.early) add('bundle', 'Launch-block buyers', 'ok', 'Nobody else bought in the launch block or the next one.');
  else {
    const held = l.heldPct || 0;
    add('bundle', 'Launch-block buyers', held <= 5 ? 'ok' : held <= 15 ? 'warn' : 'bad',
      l.early + ' other buy' + (l.early === 1 ? '' : 's') + ' in the first two blocks' + (l.checked < l.early ? ' (first ' + l.checked + ' checked)' : '') + '; those wallets still hold ' + fmt(held) + '.');
  }

  if (rec && rec.venue === 'meteora') {
    add('fees', 'Platform fee', 'ok', 'Built into this pool\'s curve config on Meteora. It applies to every trade and the creator cannot change it.');
  } else if (rec) {
    if (!rec.platformBps) add('fees', 'Platform fee', 'ok', 'None. BurnerPad takes no share of this coin\'s creator fees.');
    else add('fees', 'Platform fee', rec.split ? 'ok' : 'warn',
      rec.split ? 'A ' + (rec.platformBps / 100) + '% share of creator fees was signed on-chain by the creator.' : 'The fee split was not completed, so creator fees go entirely to the creator wallet.');
  }
  return out;
}
module.exports = { trustChecks };
