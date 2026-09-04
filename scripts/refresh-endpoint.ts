/**
 * The local endpoint behind the Refresh button.
 *
 * The app is a static site and the league is private, so the browser cannot
 * fetch a new snapshot itself — ESPN serves this league only to a request
 * carrying the `SWID` and `espn_s2` cookies, and `fetch` refuses to set
 * `Cookie` at all. That is why the snapshot exists in the first place, and it
 * is why Refresh used to mean nothing more than "drop the IndexedDB cache and
 * re-read the same files".
 *
 * This closes the gap without moving a single credential into the client. The
 * button posts to a route that only exists when something is serving the app
 * locally — `npm run dev`, or `npm run serve` over the built copy — and that
 * route runs exactly the scripts a person would run by hand, in Node, with the
 * cookies read from the gitignored `.env` it already reads them from. The
 * response says what happened; the page then reloads and picks up the new
 * `generatedAt`, which invalidates precisely what changed.
 *
 * On GitHub Pages the route is deliberately absent. GitHub Actions performs
 * the authenticated pull on its schedule; the hosted button clears its local
 * cache and reads the newest deployment.
 *
 * Deliberately unauthenticated and bound to loopback by whatever is serving it.
 * It runs no user input. A caller controls two things: whether to also refit,
 * and which league to pull — and the league is a key looked up in the shipped
 * config, never a string passed through. An unknown key is rejected before
 * anything spawns, so what reaches a process is always one of a fixed set of
 * values this repo wrote itself. It must never be mounted on a public listener,
 * which is why it lives in `scripts/` and is wired only into the dev server and
 * `npm run serve`.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Extension-qualified, unlike the rest of the repo: this module is reachable
// from `vite.config.ts`, which is checked under `nodenext` resolution where a
// bare relative specifier is an error.
import { DEFAULT_LEAGUE_KEY, findLeague, LEAGUES } from '../src/lib/leagues.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The route the client posts to. Relative, so a base path still resolves. */
export const REFRESH_PATH = '/api/refresh';

/**
 * The steps a refresh runs, in order.
 *
 * The two fits are separate steps rather than one, and both are optional,
 * because they cost very different amounts of time. `snapshot` is the part a
 * manager actually wants on a Sunday — new scores, new projections, new
 * lineups — and takes about a minute. Refitting the models over three seasons
 * takes several more and cannot change until a season ends, so the button asks
 * for it only when explicitly told to.
 */
const STEPS = {
  snapshot: { label: 'Pulling from ESPN', args: ['scripts/snapshot.ts'] },
  /*
   * Carries the existing fitted models onto the new snapshot's stamp, but only
   * where a hash says none of their inputs changed — which is true of every
   * in-season refresh, because new scores cannot alter a model fitted on three
   * finished seasons. Without this, a one-minute refresh would leave the app
   * with two models the build considers stale, and the only cure would be
   * several minutes of refitting to reproduce a byte-identical result.
   */
  restamp: { label: 'Carrying models forward', args: ['scripts/restamp-fits.ts'] },
  priors: { label: 'Refitting priors', args: ['scripts/fit-priors.ts'] },
  projection: { label: 'Refitting projections', args: ['scripts/fit-projection.ts'] },
  /*
   * Rebuilds the distributed site, and only `npm run serve` asks for it.
   *
   * `npm run serve` reads `dist/data`, while the snapshot script writes
   * `public/data`. A rebuild copies the newly pulled JSON into the directory
   * being served before the browser reloads.
   *
   * The dev server reads `public/data` directly and needs none of this, which is
   * why the step is opt-in rather than always-on.
   */
  rebuild: { label: 'Rebuilding the page', args: ['--build'] },
} as const;

export type RefreshStep = keyof typeof STEPS;

export interface RefreshResult {
  ok: boolean;
  steps: Array<{ step: RefreshStep; label: string; ok: boolean; ms: number; output: string }>;
  error?: string;
}

/** How long any one step may run before it is treated as hung. */
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

/** Trailing output kept per step, so a failure reports its own message. */
const OUTPUT_TAIL = 4000;

let running: { league: string; promise: Promise<RefreshResult> } | null = null;

function runStep(
  step: RefreshStep,
  leagueKey: string,
): Promise<{ ok: boolean; output: string; ms: number }> {
  const started = Date.now();

  return new Promise((resolve) => {
    /*
     * `tsx` rather than a compiled binary, because these scripts are the same
     * ones a person runs by hand and there is no build step between them.
     * Resolved out of the project's own node_modules so the endpoint does not
     * depend on anything being on PATH.
     */
    /*
     * `--build` runs npm rather than a script, because rebuilding is the
     * project's own `npm run build` — the same command a person would type.
     */
    const [command, args] =
      STEPS[step].args[0] === '--build'
        ? [process.env.npm_execpath ?? 'npm', ['run', 'build']]
        : [
            process.execPath,
            [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), ...STEPS[step].args],
          ];

    const child = spawn(command, args, {
      cwd: ROOT,
      // Every script resolves its own data directory from this — see
      // `scripts/league-paths.ts`. `leagueKey` is a config key, not a path.
      env: { ...process.env, ESPN_LEAGUE: leagueKey },
      stdio: ['ignore', 'pipe', 'pipe'],
      // npm resolves through a shell on some platforms; a node binary does not.
      shell: command !== process.execPath,
    });

    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += `\n${step} exceeded ${STEP_TIMEOUT_MS / 60000} minutes and was stopped`;
    }, STEP_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n${error.message}`, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim(), ms: Date.now() - started });
    });
  });
}

/**
 * Runs a refresh, or joins the one already in flight for the same league.
 *
 * Two refreshes of one league at once would have two processes writing the same
 * JSON files, and a client that reloaded between the two writes would read a
 * snapshot half from each. Joining is also the behaviour a person expects from
 * pressing a button twice.
 *
 * A request for a *different* league is refused rather than joined. Joining
 * would hand back the other league's result as if it were this one's, and
 * running both at once is worse still: they are the same ESPN account, and
 * two full pulls in parallel is the reliable way to be rate-limited into a
 * failure. Refusing says plainly what is happening and leaves the button
 * usable a minute later.
 */
export function refresh(
  steps: RefreshStep[],
  leagueKey: string = DEFAULT_LEAGUE_KEY,
): Promise<RefreshResult> {
  if (running) {
    if (running.league === leagueKey) return running.promise;
    return Promise.resolve({
      ok: false,
      steps: [],
      error: `A refresh of ${running.league} is already running. Try again when it finishes.`,
    });
  }

  const promise = (async (): Promise<RefreshResult> => {
    const results: RefreshResult['steps'] = [];

    const queue = [...steps];

    for (let i = 0; i < queue.length; i++) {
      const step = queue[i];
      const { ok, output, ms } = await runStep(step, leagueKey);
      results.push({ step, label: STEPS[step].label, ok, ms, output });

      /*
       * A failed snapshot stops everything, because the fits read what it
       * writes and refitting against a half-written snapshot is worse than not
       * refitting. A failed *fit* does not: the snapshot on disk is already
       * good, and the app degrades to the previous model rather than to nothing.
       */
      if (!ok && step === 'snapshot') {
        return { ok: false, steps: results, error: output.split('\n').at(-1) ?? 'snapshot failed' };
      }

      /*
       * `restamp` exits non-zero when a model's inputs have genuinely moved —
       * a new finished season, an edited scoring table — and that is a request
       * rather than an error. Refitting is inserted here instead of being
       * demanded of whoever pressed the button, which is what makes a refresh
       * that crosses a season boundary heal itself.
       */
      if (!ok && step === 'restamp' && !queue.includes('priors')) {
        const healing: RefreshStep[] = ['priors', 'projection'];
        if (process.env.ESPN_REFRESH_REBUILD === '1') healing.push('rebuild');
        queue.splice(i + 1, 0, ...healing);
        results[results.length - 1].ok = true;
      }
    }

    const failed = results.filter((r) => !r.ok);
    return {
      ok: failed.length === 0,
      steps: results,
      error: failed.length ? `${failed.map((r) => r.step).join(', ')} failed` : undefined,
    };
  })().finally(() => {
    running = null;
  });

  running = { league: leagueKey, promise };
  return promise;
}

/**
 * Connect-style middleware, shared by the Vite dev server and `npm run serve`.
 *
 * Returns true when it handled the request, so the caller knows to stop.
 */
export async function handleRefresh(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '';
  if (!url.split('?')[0].endsWith(REFRESH_PATH)) return false;

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(JSON.stringify({ ok: false, error: 'POST only' }));
    return true;
  }

  // `?fit=1` also refits the models. Off by default: it adds several minutes
  // and nothing it produces can change until a season ends.
  const refit = /[?&]fit=1(&|$)/.test(url);

  /*
   * `?league=<key>` picks which league to pull, defaulting to the first.
   *
   * Resolved through the config rather than used as given: what continues is
   * `league.key`, a string this repo wrote, so a caller cannot put anything of
   * their own into the environment of a spawned process. An unrecognised key is
   * a 400 rather than a silent fall back to the default, which would otherwise
   * refresh a league nobody asked for and report success.
   */
  const requested = new URL(url, 'http://localhost').searchParams.get('league');
  const league = requested ? findLeague(requested) : LEAGUES[0];
  if (!league) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        steps: [],
        error: `Unknown league. Configured: ${LEAGUES.map((l) => l.key).join(', ')}.`,
      }),
    );
    return true;
  }

  const steps: RefreshStep[] = refit
    ? ['snapshot', 'priors', 'projection']
    : ['snapshot', 'restamp'];

  // Set by `npm run serve`, which must copy the new snapshot into `dist/data`.
  if (process.env.ESPN_REFRESH_REBUILD === '1' && !steps.includes('rebuild')) {
    steps.push('rebuild');
  }

  try {
    const result = await refresh(steps, league.key);
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        steps: [],
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return true;
}
