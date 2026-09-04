/**
 * Carries a fitted model forward onto a fresh snapshot, when that is honest.
 *
 * Every file in `public/data` carries the snapshot's `generatedAt`, and the
 * loader rejects a fitted model whose stamp disagrees with the index. That
 * check is what stops a stale model shipping beside fresh data, and it should
 * stay.
 *
 * It also means an ordinary Sunday refresh — new scores, new projections, the
 * same three finished seasons — leaves `priors.json` and `projection.json`
 * looking stale when nothing about them is. Refitting to fix that spends
 * several minutes reproducing a byte-identical model.
 *
 * So each fit records a hash of the inputs it actually reads, and this moves the
 * stamp forward only when that hash still matches. If a season has been added,
 * the scoring table edited, or a player's position changed, the hash differs and
 * nothing is restamped — the operator is told to refit instead. The stamp check
 * keeps its meaning, and the refresh stays fast.
 *
 *   npm run restamp
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fitInputsHash } from './fit-inputs';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const FITS = ['priors.json', 'projection.json'];

const out = (msg: string) => process.stdout.write(`${msg}\n`);

const { generatedAt } = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
  generatedAt: number;
};
const current = fitInputsHash();
let stale = 0;

for (const name of FITS) {
  const path = join(DATA, name);
  if (!existsSync(path)) {
    out(`  ${name}: absent — run the fit that writes it`);
    continue;
  }

  const payload = JSON.parse(readFileSync(path, 'utf8')) as {
    generatedAt: number;
    inputsHash?: string;
  };

  if (payload.generatedAt === generatedAt) {
    out(`  ${name}: already current`);
    continue;
  }

  /*
   * A fit written before this mechanism existed carries no hash. It is not
   * restamped: there is nothing to compare it against, and guessing that its
   * inputs are unchanged is exactly the assumption the hash exists to replace.
   */
  if (!payload.inputsHash) {
    stale++;
    out(`  ${name}: no input hash — refit it once and this becomes automatic`);
    continue;
  }

  if (payload.inputsHash !== current) {
    stale++;
    out(`  ${name}: inputs have changed — refit required`);
    continue;
  }

  payload.generatedAt = generatedAt;
  writeFileSync(path, JSON.stringify(payload));
  out(`  ${name}: carried forward — inputs unchanged`);
}

/*
 * A non-zero exit when anything is left behind, so the caller can react rather
 * than read.
 *
 * This is what makes the refresh self-healing: both the button and the deploy
 * workflow run the fits only when this says they have to, which is roughly
 * never during a season and unavoidable when a new one lands. The alternative
 * is refitting every time, and `fit:projection` grows twenty thousand trees
 * over three seasons — two minutes to reproduce, in the ordinary case, a
 * byte-identical file.
 */
if (stale > 0) {
  out(`\n${stale} fit${stale === 1 ? '' : 's'} could not be carried forward.`);
  out('Run npm run fit:priors and npm run fit:projection.');
  process.exitCode = 1;
}
