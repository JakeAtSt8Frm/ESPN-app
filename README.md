# UK-BG — League Analytics

A fantasy football analytics app for the **UK-BG** ESPN league, built around the
league's own scoring settings rather than any of ESPN's precomputed totals.

[Open the deployed app](https://jakeatst8frm.github.io/ESPN-app/)

Static site. No backend and no API key in the client. League data is pulled from
ESPN by a Node script and shipped as JSON, because ESPN will not serve a private
league to a browser (see [Why there is a snapshot](#why-there-is-a-snapshot)).

## The league

| | |
|---|---|
| Format | 8 teams, full PPR, head-to-head points, **redraft** — snake draft, `keeperCount: 0` |
| Starters | QB, RB×2, WR×2, TE, FLEX, D/ST, K |
| Bench | 7, plus 1 IR |
| Season | 14 matchup periods, 6 playoff teams, seeded on total points scored |

The league switcher also includes **O.J. Invitational: 8 teams, half PPR**
(0.5 points per reception), with its own ESPN scoring table and fitted history.
Players, Prediction Lab and Settings identify the loaded format explicitly.

This is a standard format, which is exactly why the scoring engine still earns
its place: "standard" hides a kicking ladder split four ways by distance, a D/ST
scoring table whose 27 stat ids mean something different in slot 16 than they do
anywhere else, and a points-allowed ladder that is nine mutually exclusive
buckets. There are 26 scoring keys outside D/ST and 27 inside it, and ESPN
documents none of them.

## Nothing in the ESPN API is self-describing

Stats arrive as numeric ids with no dictionary:

```json
{"3": 3668, "4": 25, "20": 10, "23": 112, "24": 579, "25": 14, "72": 3}
```

`espn-stats.ts` is the table that turns those into names, and every id in it that
carries points was **derived from data rather than copied from a community
table**. ESPN publishes an `appliedTotal` alongside most stat blocks, computed
server-side under this league's real settings; the app never reads it as a source
of truth, which means the two can be compared.

The kicking block is the one worth spelling out, because the obvious reading is
wrong. The three distance buckets are ordered **longest first**:

```
Brandon Aubrey, 2025    id 74 = 11 made / 75 = 17 att / 76 = 6 missed
                        id 77 = 10 made / 78 = 10 att / 79 = 0 missed
                        id 80 = 15 made / 81 = 15 att / 82 = 0 missed
```

Read id 74 as 0–39 and you have a kicker who missed six chip shots and went a
perfect 15-for-15 from 50+. Read it as 50+ and you have Aubrey. The finer 50–59
and 60+ splits confirm it independently: they sum to exactly the 74/75/76 totals.
A community table that had this backwards would have scored every kicker in the
league wrong all season, and every total would still have looked plausible.

### Ids that are deliberately left unnamed

Six are reported and not labelled, because each was a plausible guess that did
not survive checking, and a wrong label on a player sheet is worse than no label:

- **155, 156** sum to a player's games played, so "wins and losses" is the
  obvious reading — except teammates disagree. Fifteen Lions carry nine different
  pairs, so whatever they split, it is not the team's record.
- **158** read as snaps makes a kicker (155) busier than a receiver (66) and
  gives a quarterback 234 in a season of roughly 1,100.
- **59, 212, 213** are reproduced by no arithmetic against any other field.

They pass through under their numeric key: present, inspectable, and impossible
to mistake for a fact. The Value Score's snap-share term was **removed** rather
than fed id 158, and its weight redistributed across the volume signals.

## Verified

`npm run verify` recomputes every score from raw stat lines, checks it against
ESPN's own arithmetic, and runs position-aware analytics regressions over three
populations that fail differently:

```
2025 season totals           compared    719  mismatches     0  match 100.0000%
2025 game logs               compared  11713  mismatches     0  match 100.0000%
2026 weekly projections      compared   7965  mismatches     0  match 100.0000%

total                        compared  20397  mismatches     0  match 100.0000%
```

It runs on every deploy, against the snapshot about to ship. A stat id ESPN
renumbers between seasons fails there rather than quietly scoring zero in
somebody's lineup.

### What it cannot catch on its own

This check is blind to a whole class of error, and it is worth being precise
about which. Both sides of the multiply — the scoring settings and the stat line
— are keyed through the *same* `STAT_IDS` table, so **any bijective relabelling
cancels out and still reports 100%**. Swap two ids consistently and the total is
unchanged; verify sees nothing.

That was not hypothetical. Four D/ST ids were mislabelled and this check passed
20,374 of 20,374 anyway. The points-allowed ladder was shifted a whole bucket,
so a chip reading "Allowed 22-27" was a game where the defence allowed 28-34,
and a player sheet printed a defence's sacks under "Tackles for loss". **No
score was ever wrong** — the relabelling was a consistent permutation, which is
exactly why it survived so long.

The cause was a circular derivation. The kicking block was pinned down against
data that could refute it: the 50-59 and 60+ splits sum to the 50+ bucket, and
makes fall away with distance, so the buckets cannot be the other way round. The
D/ST ladders were assigned by *assuming* the league uses ESPN's default point
values and reading off which bucket carries which number — which can only ever
recover the assumption it started from.

### `npm run verify:stat-ids`

So there is a second check, and it validates labels against evidence from
outside the scoring identity:

```
D/ST rate bounds  (544 game logs)
  ok   def_sack       2.36/game in 87% of games   (expect 1.6-3.4 in 70-98%)
  ok   def_int        0.70/game in 50% of games   (expect 0.4-1.1 in 32-68%)
  ok   def_fum_rec    0.44/game in 36% of games   (expect 0.25-0.85 in 22-55%)
  ok   def_blk_kick   0.08/game in  8% of games   (expect 0.01-0.2 in 1-20%)

points-allowed ladder against scoring reconstructed from the opposing offence
  ok   def_pa_7_13    n=79  median 10,  10th-90th  7-13
  ok   def_pa_28_34   n=93  median 31,  10th-90th 28-35
  ok   def_pa_46p     n=3   median 48,  10th-90th 47-52

yards-allowed ladder against def_yds_allowed on the same line
  ok   544 agree, 0 disagree

kicking distance buckets, against season totals
  ok   the four buckets partition every field goal made — 42 kickers, 0 disagree
  ok   makes fall away with distance — 0-39: 484, 40-49: 264, 50-59: 171, 60+: 12
```

A key called `def_sack` that fires in half a defence's games at 0.7 a time is
not sacks, whatever the arithmetic says. The corrected table now reproduces the
league's settings page exactly — sack 1, interception 2, blocked kick 2, points
allowed 28-34 at -1 and 46+ at -5 — which it did not before.

### `npm run verify:history`

And a third, because the app now reads finished seasons through a *different*
endpoint than the rest of the snapshot — a different league, with a different
scoring table — and a silent disagreement between the two would poison every
distribution fit downstream while looking perfectly plausible.

2025 is reachable both ways, so every week the two routes share is rescored and
compared, along with four properties agreement alone cannot cover: that the
recovered projections are pregame rather than reconstructed, that there are
enough of them per position to fit a 257-knot shape on, that the fixture join
resolves an opponent for every played week, and that the three seasons are
actually three different years rather than one written three times.

## The three metrics

**Score** — `scoringSettings` × raw stat keys, with the D/ST override applied
per position. Exact, verified above.

**Value Score (0–1000)** — the headline number, the average of two
within-position valuations: an in-season half and a rest-of-season half. Every
signal in both is a percentile *within the player's own position group*, which is
what lets the two be averaged and read the same way — "top of his own pool", not
comparable across positions.

- *In-season half* blends 10 signals, led by PPG (.24), exponentially weighted
  form (.18), the current projection (.15) and recent opportunity share (.14).
  Age- and market-blind: pure "producing now".

- *Rest-of-season half* answers "what is he worth from here through the fantasy
  playoffs". Its lead leg is **rest-of-season VORP** — remaining weekly
  projections summed, minus the production of the player who would replace him,
  with replacement level set from the league's real starting requirements. On top
  of it: ESPN's live draft market, projected role, current form, availability,
  and the strength of the schedule ahead.

**Matchup Score (0–100)** — an opponent-only next-week rating, blending
schedule-adjusted points allowed (.60) with opportunity volume allowed (.40).
Player strength is deliberately excluded: that describes how good the player is,
not whether the defence provides an advantage.

Starter replacement is now derived from the scored player pool: reserve each
position's dedicated starters, then allocate FLEX seats to the best remaining
projections. Half-PPR and full-PPR can therefore produce different RB/WR/TE
replacement levels in the same eight-team lineup. Ties at the FLEX cutoff share
the seats instead of favoring whichever position was processed first. Season
value uses remaining totals; trade value uses points per projected game.

The in-season schedule adjustment measures position-unit points per opponent
game. Extra zero-point backups cannot make an opponent look tougher, and unknown
opponents do not contaminate the comparison baseline. Availability excludes a
known completed bye while continuing to count missed games.

### Why the second half is not a dynasty model

The app this one is modelled on runs a dynasty league, and its second valuation
asks "what is this player worth to hold for years": multi-year production, an age
curve, longevity, a trade market. **None of that transfers.** This league is an
eight-team redraft with a snake draft and `keeperCount: 0` — every roster is
dissolved in February, so a 23-year-old and a 31-year-old with the same
rest-of-season outlook are worth exactly the same thing here. Porting an age
curve over would not have been conservative, it would have been wrong.

### Buy and sell

The verdict is two percentiles, built the same way over the same population:
where this model ranks a player among the priced players at his position, against
where ESPN's drafters rank him among that same set.

Ranking them over *different* pools is the trap, and it is a quiet one. ESPN
prices far fewer players than it lists — most of the universe sits at an auction
value of zero — so a market percentile taken over the priced players while every
other leg is a percentile over all of them puts the market leg systematically
below the intrinsic one by construction. The verdict then stops meaning "the
market disagrees" and starts meaning "this player has a price at all".

Two cases get an explicit abstention rather than a call:

- **Thin market.** The bottom fifth of ESPN's auction values is rounding noise —
  a wall of $0 and $1 tags against a $60 top — so a percentile gap there measures
  where a worthless player happened to land, not disagreement.
- **No read.** Without production *or* a projection the intrinsic side is a fixed
  prior rather than an opinion, and a prior can only ever open a gap in one
  direction. Calling that a sell dresses an absence of evidence up as
  disagreement.

### The matchup matters far more for some positions than others

Measured, not asserted. `npm run research:matchup` correlates the shipped rating
against how far a player's score landed from his own season mean, over the prior
season, with every rating built only from weeks *before* the one it is tested on:

| DST | K | QB | TE | WR | RB |
|---|---|---|---|---|---|
| .282 | .093 | .070 | .047 | .046 | .028 |

**The order is not the one you would guess.** A team defence is three times more
matchup-dependent than anything else on the roster — which on reflection is
nearly a tautology, since a D/ST's entire score is the offence it faces, so "who
are they playing" is not context for the projection, it *is* the projection.
Running backs sit at the other end: volume is assigned during the week, and a bad
matchup takes carries away far more slowly than it takes away sacks and
turnovers.

Those were measured against a player's deviation from his own season mean,
because the sharper instrument — his miss against his *projection*, which already
prices in his form and role — needed a historical weekly projection that was
thought not to exist. It does, so the sharper measurement now runs, over 18,966
weekly pairs with every rating rebuilt from weeks strictly before the one it is
scored on:

|  | DST | K | QB | TE | WR | RB |
|---|---|---|---|---|---|---|
| against own mean | 1.00 | .33 | .25 | .17 | .16 | .10 |
| against projection | 1.00 | .31 | .28 | .19 | .17 | **.01** |

The two agree almost everywhere, which is the useful result: the blunt instrument
was not lying and its ordering survives. The one real change is running back,
which falls from a tenth to essentially nothing — a correlation of .002 over
3,103 pairs. A player's own mean absorbs part of his schedule, so the old figure
was crediting the rating with schedule it had not earned; against a projection,
which already knows his workload, the opponent adds nothing measurable to a
running back at all.

`npm run fit:priors` re-measures these every run and **fails if the shipped
constants have drifted** more than a tenth from what the data says, so they
cannot quietly rot.

The score is never rescaled by influence, but chips below the influence floor are
**dimmed and labelled**, so a column of identical-looking pills doesn't present
noise with the same confidence as signal.

## The history-only projection challenger

The user-facing **App projection** is the median from the historically tested
forecast above: ESPN's current baseline, re-centred for measured residual bias
and adjusted for the opponent. `npm run fit:projection` also builds a separate
history-only challenger from the league's scored history. That model remains a
useful diagnostic, but it is no longer presented as the app's headline number:
it cannot inherit current role, injury, or offseason information, and the saved
data does not contain prior weekly ESPN projections for a direct comparison.

Features are all pregame — weighted recent form, three-week and season means,
opportunity volume and share of the player's own unit, availability, and the
pregame matchup rating, which is rebuilt as it stood before each week so no week
contributes to its own feature.

### It has to be fit on the population it is read for

The first version was fit on every rostered player-week and it was badly wrong,
in a way that only showed up when somebody looked at a specific row: **Lamar
Jackson projected at 5.0 against ESPN's 19.1.**

Over half of every position's rostered weeks are weeks the player did not
appear — 842 of 1518 at quarterback — so the median weekly score across all of
them is **0.0**, and the model was faithfully reporting the median of a
population dominated by backups on a bench. Meanwhile the column is read for
starters, whose median is 13.2.

Conditioning the target on weeks he actually played fixes it, and cuts the
claimed improvement by two thirds:

```
rolling-origin holdout — fit up to week C, score C+1 and C+2, for C in 9, 11, 13, 15

group     n   baseline MAE   model MAE   improvement   level vs median   per-window
QB      276        6.700       6.965         -4.0%              0.94   --+-
RB      806        3.849       3.752         +2.5%              0.92   -+++
WR     1184        4.071       3.944         +3.1%              1.00   ++++
TE      738        2.908       2.833         +2.6%              1.05   ++++
K       233        4.108       3.924         +4.5%              0.94   ++++
DST     242        5.224       4.770         +8.7%              1.05   +++-

pooled 3479        4.064       3.960         +2.6%
```

The earlier figure was 7.7%. Most of that was the model learning to predict zero
for players who were not going to play, which is easy and worth nothing to
somebody setting a lineup.

### Why the loss is absolute and not squared

Squared-loss boosting and ridge regression both came out **worse than doing
nothing clever** — worse than carrying a player's weighted recent average
forward. They beat it on RMSE. That is the two losses behaving correctly:
squared error is minimised by the conditional mean and absolute error by the
conditional median, and a weekly fantasy score is skewed far enough that the two
are far apart.

So the trees are grown on the *sign* of the residual and every leaf is refit to
the median of the residuals reaching it. Same features, same depth, opposite
sign on the result.

One consequence matters when comparing its diagnostic output: the challenger is
a **median** and ESPN's is closer to a mean, so on a skewed position it generally
sits below. How far below is measurable — the median-to-mean ratio over
startable players is 0.86 at running back, 0.90 at receiver, 0.91 at tight end,
1.02 at quarterback.

### Four gates, because accuracy alone missed all of this

A group only ships if it clears every one, and each exists because something got
past the ones before it:

| Gate | What it catches |
|---|---|
| **Beats its baseline** | a model with no edge at all — quarterback fails here today |
| **Wins most holdout windows** | an edge that is one lucky fortnight |
| **In-season level** | a column that orders correctly and sits in the wrong place |
| **Cold-start level** | the path the app runs in week one, which the other three cannot see |

The last one is the subtle one. Before any games, the app seeds a player from
his prior-season level — a state that appears nowhere in the training set, where
every row has real in-season history behind it. Nothing tested it, and it was
broken: fed a player's own prior-season average, the model returned 0.80 of it
for a kicker where the skew justifies 0.97, and 1.02 for a tight end where it
justifies 0.87. That gate compares against each position's *measured* skew
rather than against 1.0, because a median model handed a mean is supposed to
come back low.

A group failing the cold-start gate still ships — the two paths are different
questions, and discarding a model that works from week three because it cannot
be trusted in week one throws away most of its value. The app simply prints
nothing for that group until this season has weeks of its own. Today that is
tight end and kicker; quarterback is absent outright.

### Early weeks lean on last season, and say so

The seed is last season's *level*, held flat, over the weeks he played. Not its
closing run: weighting by recency across a boundary containing a draft, free
agency and a training camp cannot be justified, and it is actively harmful,
because the decay leans hardest on the most recent week and the most recent week
of an NFL regular season is the one every playoff-bound starter sits out.
Seeding from the tail projected Ja'Marr Chase at 3.6 points.

It still knows nothing about an offseason move — Isaiah Likely changed teams and
reads far below ESPN, which has the news. The player sheet says so explicitly
until the season has games in it.

### `priorLevel` is no longer idle

This section used to end by saying the `priorLevel` feature was wired up and
doing nothing, because fitting on one season leaves no season before it to fill
that column with — **the one place a second season of history would change the
model rather than just enlarge it**. That was a train/serve mismatch on exactly
the feature the app leans on hardest in September: structurally zero in
training, and a real number at serve time.

The fit now spans 2023, 2024 and 2025, with each season's rows carrying the
level a player scored the season before. The trees split on it:

```
feature usage — share of splits, per group

feature          QB    RB    WR    TE     K   DST
ewma         11.6% 24.6% 16.7%  5.5%  9.5% 12.5%
seasonMean   12.9%  9.4% 25.6% 18.7% 12.1% 13.5%
oppEwma      12.1% 25.4% 14.9% 43.1% 14.4% 10.9%
matchup      13.0%  3.5%  1.7%  3.0% 13.5% 17.2%
priorLevel    6.6%  4.6% 11.8%  8.5% 11.6% 10.5%
```

Every group uses it, from 4.6% of splits at running back to 11.8% at receiver,
against exactly 0% before. `matchup` is worth reading too: it reproduces the
positional ordering measured independently below — 17% of a D/ST's splits and
1.7% of a receiver's — from a model that was never told about it.

Training rows went from about 6,000 to 20,276, and every gate improved:

```
group     n   baseline MAE   model MAE   improvement   level vs median   per-window
QB      835        6.291       6.072         +3.5%              0.98   +-+++-+++++-
RB     2336        3.822       3.683         +3.6%              1.04   +--+++++++++
WR     3575        4.098       3.975         +3.0%              1.01   +-+-+-++++++
TE     2190        2.827       2.699         +4.5%              1.02   ++-++-++++++
K       692        4.070       3.876         +4.8%              0.92   +++++-++++++
DST     718        5.400       4.892         +9.4%              0.92   +-++-+++++++

pooled 10346        4.032       3.865         +4.1%
```

Pooled improvement went from 2.6% to 4.1%, and **quarterback ships for the first
time** — it previously failed its own baseline at −4.0% and was excluded
outright. The holdout is stricter than it was, not looser: the cut walks through
one season at a time and everything from an earlier season is always training,
so no week is ever scored by a model that has seen it or anything after it.

### The baseline can now be ESPN, and is

The previous version of this section explained why comparing against ESPN was
impossible for a finished season. It is not, and the comparison is the more
interesting number:

```
against ESPN, on the same held-out weeks

group     n    ESPN MAE   model MAE   gap
QB      703      6.244       6.577   +5.3%
RB     2024      4.132       4.157   +0.6%
WR     3290      4.227       4.224   -0.1%
TE     1783      3.271       3.243   -0.9%
K       691      3.707       3.871   +4.4%
DST     718      4.756       4.892   +2.9%

pooled 9209      4.177       4.225   +1.1%
```

A model that sees nothing but a player's own scoring history lands **1.1% behind
ESPN overall**, and slightly *ahead* of it at receiver and tight end. It is not
a gate and should not be: ESPN knows about depth charts, trades and Wednesday
practice reports that no history-only model can see, and a history-only model
that beat it every week would be evidence of a leak rather than of skill. It is
printed because a second opinion displayed beside a source ought to have its
distance from that source measured rather than guessed at.

The form baseline is still the gate, because beating "carry his recent average
forward" is what justifies a model existing at all.

`npm run verify:projection` checks the machinery: that a planted step function is
recovered, that a model survives the JSON round-trip the snapshot puts it through
unchanged, that the fit tracks the median of a skewed target rather than its
mean, and that every shipped group cleared its gates.

## Weekly forecasts, as distributions

Every other number here is a point estimate, which is the wrong shape for the two
questions actually asked on a Sunday: *what is my floor* and *can I still win*.
Both need the spread, and the spread can't be asserted — it has to be measured.

So for each position group the app fits the conditional distribution of a real
result given its projection. Four properties are measured rather than assumed:

- **Opponent adjustment.** The source projection is moved by the defence's
  schedule-adjusted custom points and opportunity volume allowed to that exact
  position. The move is damped by the holdout influence above and capped at 20%,
  so the matchup corrects ESPN rather than replacing it. On the shipped 2025
  baseline the ranges are RB `0.985–1.017`, QB `0.935–1.068`, K `0.875–1.100`
  and D/ST `0.800–1.200`.

- **Bias.** Projections aren't centred on the outcome. Correcting that median
  shift is what makes the central estimate better than the projection it started
  from.
- **Heteroskedasticity.** A 20-point projection is wrong by more points than a
  5-point one, so the scale is fit as a line in the projection level. It runs
  from `2.3 + 0.48·p` for a TE — where a big projection really is riskier — to
  a flat `5.1` for a kicker, whose spread doesn't widen with the forecast at
  all.
- **Skew.** A floor is bounded near zero while a ceiling is a three-touchdown
  game. Assuming normality would understate every ceiling, so the shape is
  carried as the empirical quantiles of the standardised residual.

A player who is projected but sometimes doesn't appear carries that too, as a
point mass at zero, counted over the weeks he was *projected for*.

### The bootstrap, and its honest limit

In week one there is nothing of this season to measure. Without a fallback the
model would carry no fit at all, every forecast would collapse onto its point
estimate, and every win probability would come out 0% or 100% — a simulator with
no variance reports certainty rather than odds.

So the fit bootstraps on finished seasons — and it now does so on **18,966 real
weekly pairs across three of them**, rather than on the prorated stand-in this
section used to apologise for. That stand-in divided a season projection by games
played: a real ESPN number at the wrong granularity, sound for the *spread* and
weak exactly where a season projection differs most from a weekly one, which is
the median shift.

`npm run fit:priors` builds the fit in Node and ships it as `priors.json` —
fitted objects rather than the pairs behind them, which is 244KB against eight
megabytes. The client installs it directly; there is nothing a phone improves by
rebuilding a 257-knot shape.

The current-season pairs still accumulate from week one, and once a group has 250
of its own the borrowed fit is dropped **entirely rather than blended** — mixing
granularities into one scale line would fit neither.

### Measured out of sample, against a season it never saw

The holdout is now a season boundary rather than a half-season split: fit on
2023 and 2024, score all of 2025. That is the shape of the question the app
actually asks, which is always "what does last year tell me about this year".

```
                                    coverage MAE    median MAE
fit on 2024 alone                       1.14pp         4.361
fit on 2024+2023                        1.02pp         4.360
the projection it starts from              —           4.536   n = 6,402
```

**1.02 points of mean absolute coverage error**, against 2.68 for the prorated
bootstrap this replaces and 1.14 for the app this one is modelled on. Pooling a
second season beats the most recent one alone on both coverage and point
accuracy, which is the case for carrying three.

Point accuracy over the same held-out season: source projection MAE 4.536,
bias-corrected median **4.360**, a 3.9% improvement. Lower than the 7.0% claimed
before, and more believable — the earlier figure was measured against a weaker
baseline on half a season.

### The per-player bias correction is switched off, and now that is a finding

Every damping in `BIAS_CORRECTION` is still zero. What changed is why. It used to
be zero because there was nothing to fit it on; it is zero now because it was
fitted, on bias measured over 2023–2024 and scored on 2025, and it does not help:

```
group   n     damping   MAE at 0     best MAE   improvement
QB      459    0.00       6.3815       6.3815      0.00%
RB     1051    0.00       4.5410       4.5410      0.00%
WR     1775    0.00       4.5417       4.5386      0.07%
TE     1017    0.00       3.5089       3.5089      0.00%
K       455    0.00       3.8667       3.8559      0.28%
DST     544    0.00       4.7507       4.7500      0.01%
```

Nothing clears a half-percent floor, and a quarter of a percent on one holdout
season is inside the noise of which season happened to be held out. Players are
not persistently mis-projected by ESPN in a way that carries across a year — or
if they are, it is smaller than this can measure. The correction stays wired up
and off, and `fit:priors` re-runs the search on every fit, so a season that
disagrees will turn it on by itself.

The same fitted distribution supplies each player sheet's **Likely boom** and
**Likely bust** probabilities. They use the app's existing definitions — at
least 120% or at most 80% of ESPN's custom-scored projection — and include the
estimated chance that the player does not record a stat line.

`npm run verify:forecast` is the deterministic half — it plants a known bias,
spread and skew in synthetic data and asserts the fit recovers all three, checks
the quantile machinery round-trips against its own CDF, asserts a prorated fit
teaches no per-player bias where a weekly one does, and asserts a shipped fit is
installed as-is rather than silently refitted.

### Two play rates, because there are two questions

A finished season's projections are the *final* pregame ones, published after the
inactive list — so conditioning on a meaningful projection conditions on being
active, and the measured rate is 99%+. That is the right number for the week
about to be played and badly wrong for every week after it: the projection for
week 14 cannot know about a week 11 hamstring, and treating it as though it can
inflated every rest-of-season total and pushed every playoff probability toward
whoever had the better roster on paper.

So availability is measured twice. Over three seasons, for a player who carried a
meaningful projection in some week, how often he was actually there in a *later*
week his team played:

```
QB 78.2%   RB 85.1%   WR 84.1%   TE 87.9%   K 90.9%   DST 100.0%
```

A team defence cannot be injured, and reads exactly 100%. Everything else sits
fourteen to twenty-two points below the same-week figure. The live week uses one,
every later week uses the other, and a player ruled out today has his forward
availability halved rather than ignored — an assertion, stated as one, because
the snapshot records who is out and not how long each historical absence lasted.

## Win probability and playoff odds

Team scores are simulated by drawing each starter from his own fitted
distribution. Players who have already finished contribute their real score, so a
week in progress updates as it plays; a week that's over is replayed from kickoff
instead, because "you won" is not a probability.

Each NFL team gets one shared shock per iteration, and players load onto it
through a Gaussian copula, which induces the dependence without disturbing any of
the skewed, heteroskedastic marginals above. Measured over three finished seasons
of real weekly residuals the correlation is **0.023**, up from the 0.000 a
single-season estimate produced but still small enough that independence would be
a fine approximation here. The copula is kept because it costs nothing, and the
estimate now comes from three seasons of team-weeks rather than the two or three
a September snapshot contains — which matters, because this one number sets the
width of every simulated team total and therefore how far every win probability
sits from a coin flip.

### Medians do not add

A team total used to be the sum of each starter's median, and that is wrong in a
way that is easy to miss because every individual number looks right. The median
of a sum is not the sum of the medians, and a weekly fantasy score is skewed
enough that each median sits below its own mean — so stacking nine of them
understated a lineup by about a tenth. On the shipped snapshot the tile read
**111.7 against ESPN's 127.5** while the simulator, which draws from the same
distributions and does not make this mistake, produced 127.

Expectation adds exactly, whatever the shape and however correlated the players
are. So a player's row still shows his median, which is the right point estimate
for one player, and anything that **sums or ranks** — lineup totals, the optimal
lineup solver, trade valuations — uses his mean. The same tile now reads 126.0.

Ranking on expectation is the correction the lineup solver needed anyway: a
player with a 15% chance of not appearing has a median that ignores that risk
entirely, so the old solver would start him over a durable player of equal
median.

Rest-of-season odds replay the remaining schedule 10,000 times carrying in the
real record, then resolve the bracket under the league's own six-team format.
Every remaining week builds its own pooled distribution from that week's ESPN
projection, NFL opponent, bye schedule and best legal projected lineup. The
playoff rounds use Weeks 15–17 the same way. Future waiver moves and injuries
that are not yet in the snapshot remain unknowable; submitted lineups are used
for the live week and projection-optimal lineups stand in for later weeks.

## Why there is a snapshot

This league is private, and ESPN serves it only to a request carrying the `SWID`
and `espn_s2` cookies. A query-string pair is rejected outright.

ESPN *does* reflect `Origin` and set `Access-Control-Allow-Credentials: true`, so
CORS would allow a browser request. What it would not survive is third-party
cookie blocking, which is on by default in Safari and arriving everywhere else —
an app depending on the reader's own ESPN session would work on the developer's
machine and fail on half the league's phones. Shipping the credentials to the
client would not even fix it, since `fetch` refuses to set `Cookie`; it would
just leak them.

So `scripts/snapshot.ts` runs in Node with the cookies in the environment and
writes plain JSON into `public/data/<league>`. The shipped bundle contains no
cookie, no key, and makes no ESPN request. Everything below the fetch boundary is
pure, so the same normalisers run in the script and in the tests.

```bash
ESPN_SWID='{XXXXXXXX-...}' ESPN_S2='AEB...' npm run snapshot
```

Both can also live in a gitignored `.env` at the repo root. **The `espn_s2`
cookie expires every few months**; when it does, `snapshot` fails with that
message rather than retrying, because a stale cookie will never succeed.

### More than one league

The leagues the app can show are listed in `src/lib/leagues.ts`, and that file is
the only place their ids live — the Node scripts read it to know what to pull,
the browser reads it to build the switcher. Each league gets its own directory
under `public/data/` and `history/`, and the app reads one of them at a time.

```bash
npm run snapshot                            # every league
npm run snapshot -- --league oj-invitational  # just one
ESPN_LEAGUE=oj-invitational npm run fit:priors
```

One cookie pair covers all of them. ESPN authorises the *account*, not the
league, so a second league the same account belongs to needs no second secret; a
league on someone else's account would.

Only the snapshot loops. The fits and the verifiers are single-league by nature —
each one reads a scoring table and produces a model for it — so they default to
the first configured league and take `ESPN_LEAGUE` or `--league` to pick another.

Two things are deliberately **not** shared between leagues, and both are easy to
get wrong:

- **The finished-season history.** It is pulled from a scoring-neutral endpoint,
  so it looks shareable, and it is not: `snapshot.ts` compacts every line down to
  the stat keys the *pulling* league scores (58 for one of these leagues, 50 for
  the other). A shared copy silently drops keys the other league scores, and
  nothing fails — the fits just measure the wrong thing.
- **`MATCHUP_INFLUENCE`.** How much the opponent moves a position is a property
  of the scoring table, not of football. Measured through the same three seasons,
  these two leagues come out at QB 0.28 and 0.46. Each league's `fit:priors`
  writes its own table into `priors.json`; the constant compiled into
  `lib/matchup.ts` is only the fallback for a snapshot that has never been fit,
  and it tracks the first configured league.

### What it fetches

| Endpoint | Gives |
|---|---|
| `?view=mSettings&mTeam&mRoster&mMatchup&mStandings&mDraftDetail&mTransactions2` | League, teams, rosters, schedule, the full draft board, transactions |
| `?view=kona_player_info` | All 1,036 rosterable players with season projections, prior-season totals, ADP and auction values — one request |
| `?view=kona_player_info&scoringPeriodId=N` | Week `N` projections and actuals. ESPN publishes every future week, so the whole season is available before a snap is played |
| `?view=mBoxscore&scoringPeriodId=N` | The lineup each team actually fielded in week `N` |
| `?view=kona_playercard` | Prior-season weekly game logs for the whole universe, in one request — already scored under this league's settings |
| `/seasons/{year}?view=proTeamSchedules_wl` | NFL fixtures, kickoff times and byes, for this season and last |

| `leaguedefaults/3?view=kona_player_info` | Every week of a **finished** season — actuals *and the projections that preceded them* — for 2023, 2024 and 2025 |

Weekly *actuals* are keyed by NFL event id rather than by week, and prior-season
logs carry no opponent — both are joined back through the pro schedule.

### The finished seasons, and the claim they overturned

Every version of this README before this one said the same thing in four
different places: **ESPN publishes weekly projections only for the season in
progress**, so for a finished season there is no way to recover what a player
was projected for in a given week. That shaped the whole model. The forecast
bootstrapped on a season projection divided by games. The per-player bias
correction shipped switched off for want of anything to fit it on. The
projection challenger measured itself against a form baseline because ESPN
"could not be" the baseline. Matchup influence was measured against a blunt
instrument because the sharp one needed data that did not exist.

It was wrong. The endpoint the app read a finished season through —
`kona_playercard` against this league — carries game logs and nothing else, and
that was mistaken for a property of ESPN rather than of that one view. This
league did not exist before 2026, so its own endpoint 404s for every prior year;
but **`leaguedefaults/3`** — ESPN's standard-scoring template league — exists for
every season, and `kona_player_info` against it returns each player's full
weekly history including the projection published before each game.

The claim is checked rather than trusted. 2025 is reachable through *both*
routes, and `npm run verify:history` rescores every week they share:

```
prior season through two independent endpoints
  2025 game logs   compared 11713  mismatches 0  match 100.0000%
```

Exact agreement across 11,713 player-weeks. The same check confirms the
projections are pregame rather than reconstructed — a backfilled projection
would correlate near 1.0 with the result, and these sit at .60–.65 pooled — and
that the three seasons are genuinely different years rather than one written
three times.

What it buys is **18,966 real weekly (projection, actual) pairs**, at the right
granularity, which is what every section below now rests on.

```
2025  6402 pairs    2024  6390 pairs    2023  6174 pairs
```

The raw seasons are written to `history/<league>/` at the repo root rather than
under `public/`, because only the Node-side fits read them and eight megabytes
has no business in a deployed bundle. Everything the browser needs is distilled
into `public/data/<league>/priors.json` by `npm run fit:priors`, at about 3% of
the size.

### What the snapshot keeps, and what it drops

ESPN attaches a lot of derived rate stats and undocumented ids to every line.
None can move a score, and carrying them tripled the size of the weekly payloads,
so the snapshot keeps only the league's own scoring keys plus a short list of
usage keys — 59 in all. Weeks are written one file per week rather than as a
single payload, because the pages that need all of them are code-split anyway,
and the common case is a reader checking this week's lineup.

```
index.json      <1KB gz     league.json     14KB gz
players.json   233KB gz     history.json    94KB gz
weeks/1.json    42KB gz     weeks/*        679KB gz
```

A normal load is about 380KB gzipped. Analytics pulls the rest of the weeks on
first visit, and everything is cached in IndexedDB keyed by the snapshot's
`generatedAt` stamp — so a new snapshot invalidates exactly what changed with no
TTL guessing, and a reader who is already current re-fetches one small file.

## Pages

| Page | What it answers |
|---|---|
| **Teams** | Roster by slot, with a positional heatmap |
| **Matchups** | Every weekly head-to-head: live win probability, projected totals, score ranges, lineup matchup and player-level boom/bust risk |
| **Optimal Lineup** | The best legal lineup — against results afterwards, against projections before kickoff |
| **Players** | Searchable browser over free agents and rostered players |
| **Schedule** | The NFL week with rostered players, owners and scores overlaid, at real kickoff times |
| **Analytics** | Playoff odds, standings, all-play record, schedule luck, power index, volatility, defensive generosity |
| **History** | Season trend: Projected vs Actual vs Optimal, week by week |
| **Draft** | The board, every pick against its ADP, and draft grades |
| **Trade** | Any number of players against any number, priced in points |
| **Prediction Lab** | Start/sit probabilities, custom points targets, outcome distributions, and season-holdout validation |

### Prediction Lab

Compare two projected players from your roster, the free-agent pool, or the whole
league. The lab shows expected points, the median if active, an 80% outcome range,
and the probability of scoring **strictly more than** a chosen target. Its
20,000-simulation head-to-head comparison preserves shared NFL-team effects and
reports ties separately. It checks whether the players share a starting slot;
ownership and game locks still determine whether a move is available in ESPN.

The displayed mean and spread now integrate the same floored quantile distribution
that the simulator samples. Previously, the simulator enforced its score floor
while the expected-points calculation used the unfloored distribution. Target
probabilities also respect that floor and repeated quantile knots at the minimum.
`npm run verify:predictions` checks these cases against analytic answers and
simulated outcomes.

`npm run report:forecast` builds the track record from real, recorded weekly
projection/result pairs. It trains on 2023 to test 2024, then trains on 2023–2024
to test 2025, without fitting on either test season. The report uses each season's
player positions and this league's scoring rules. It measures the **base scoring
distribution**, including non-appearances with a recorded projection and game log;
it does not validate opponent adjustments, individual bias adjustments, or
head-to-head probabilities. Results are retained by position so a model that loses
to ESPN in a position cannot hide behind the overall average. Reports are rebuilt
for each league in the snapshot deployment workflow, and the browser rejects a
report with different scoring rules.

Historical fallback distributions now fit only played outcomes and apply the
missed-game probability once. A played zero or negative score remains in the
fit. Boom probabilities include outcomes exactly at 120% of the projection,
matching the historical boom definition; a target labeled "more than" remains
strict. Versioned reports reject results from an older fitting method.

The rebuilt half-PPR report covers 12,470 held-out player-weeks: model median
MAE **4.0244** versus ESPN **4.1893**, with **79.89%** coverage for the 80% range.
These correctness fixes leave overall measured accuracy essentially unchanged;
they do not establish a new predictive improvement.

The lab uses pregame estimates from the saved snapshot. A past-week replay uses
today's fitted model, not an archived prediction from that week. Optimal Lineup
keeps forecasts available during a week in progress and offers a separate Results
view, so one Thursday result cannot turn the remaining forecast into zeroes.

Player browsing supports weekly App/ESPN sorts, filter URLs that restore with
Back/Forward, and incremental browsing of the entire matching pool. On phones,
the score used by the selected projection sort stays visible. The team overview
flags missing starting slots, byes, and current injury concerns; current injuries
are excluded when reviewing historical lineups.

The player browser separates **League value** (rest-of-season points above
starter replacement), **Value over waivers** (above the best available player's
projected per-game rate), and **Position score** (the within-position 0–1000
blend). The points used to sort are also shown on each row. Position filtering
keeps the league-value ordering consistent. Historical production sorts use the
same season as their rank chips rather than mixing current and prior results.
Waiver comparisons use the best free player's rate without averaging in the
runner-up; the waiver sort is unavailable when no roster assignments are saved.

Any player is clickable for a detail sheet carrying, among other things, his
whole schedule: opponent, bye, the matchup rating for his position that week,
and both projections side by side.

Any player is clickable for a detail sheet with a projected-vs-actual chart, a
season profile, a "why this Value Score" breakdown, and a week-by-week table.

### Trades are the one thing the Value Score cannot price

Every other number in this app is a percentile *within a position group*, and on
the shipped snapshot that produces a ranking led by Trey McBride at 980, Jahmyr
Gibbs at 978 and **Brandon Aubrey, a $5 kicker, at 971** — ahead of Josh Allen,
Ja'Marr Chase and Christian McCaffrey. Nothing is broken: 971 correctly says
Aubrey is the best kicker alive. It just cannot be added up, and adding up is
the whole of a two-for-one.

So the Trade page prices in points and nothing else:

    Trade Points = Σ over the weeks that remain of
                   E[max(0, score − replacement)] × availability

Replacement is the last startable player at the position, taken from the
league's own lineup card, which is where positional scarcity enters — the reason
an elite kicker is worth a fifth of an elite running back is that the kicker you
can have for free is nearly as good. A bye contributes nothing rather than a
negative, because the roster spot fields the replacement that week.

The expectation, rather than a plain `max`, is what makes bench players
tradeable. Flooring the projection prices every player below the cliff at
exactly zero — 371 of 498 on this snapshot, DJ Moore at $12 and Bucky Irving at
$15 among them, all tied with a deactivated third-string kicker. What they are
worth is the chance the picture changes, so the weekly term is the value of the
start decision under the spread of how far a projection moves. **That spread is
measured on last season and it is not the outcome spread** — the decision is
made before the result, so crediting a player for variance nobody can act on
overprices exactly the noisy positions. And the option only exists where there
is a bench to rotate: this league rosters 4.6 running backs and 5.5 receivers a
team against 1.1 kickers, read off the real rosters, and that ratio scales it.

Measured against ESPN's auction values — the one genuinely cross-positional
market available, and nothing here is fitted to it:

| | Trade Points | Season VORP | Value Score |
|---|---|---|---|
| Rank correlation with ESPN $ | **0.93** | 0.75 | 0.74 |

#### What it gets wrong

Kicker and D/ST come out around twice what the market pays, and the measurement
that explains it is now three seasons deep instead of one.

Regressing a player's realised weekly level on what he was projected for **in
the season's opening weeks** — the only honest version of the question, for
reasons below:

| | QB | RB | WR | TE | K | DST |
|---|---|---|---|---|---|---|
| slope | .82 | .86 | .88 | .97 | .92 | .58 |
| correlation | .60 | .81 | .82 | .83 | **.24** | **.27** |
| players | 87 | 213 | 364 | 184 | 93 | 96 |

The old figure was .25 for a kicker on 34 players, about 1.4 standard errors
from zero — the right conclusion from a sample too small to draw it from. Three
seasons give .24 on 93, which is the same answer with enough behind it to mean
something: the gap the model prices between the best kicker and a replacement
one is a gap in a number that genuinely does not predict. And **D/ST turns out
to be no better**, at .27, which the single-season measurement never showed and
which is the second of the two positions the market disagrees about.

The word "opening" is carrying weight there. Average a player's *whole season*
of weekly projections and regress his season's actuals on that instead, and
every correlation jumps — kicker to .46, D/ST to .72, the skill positions to
.93–.95. That looks like a much better result and is close to a tautology: week
10's projection has already seen weeks 1 through 9. It measures whether ESPN's
in-season projections track results, which they do, and not the thing this page
needs to know, which is whether a gap projected *before* a run of weeks survives
them. `fit:priors` prints both columns so the difference stays visible.

Shrinking each position by its measured slope fixes that (kicker 17% → 10% of the
best running back) and costs more elsewhere than it returns: overall agreement
falls to 0.89 and receivers get cut to 80% of a running back against a market
paying 89%. So it is not applied. The page prints the warning on the positions
that earn it instead — the same choice the matchup chip makes.

#### Market value and roster fit are different questions

Additive points assume every point reaches a starting lineup, and nine of
sixteen roster spots score. So the page also replays every remaining week for
both rosters, before and after, filling each with the best legal lineup through
the app's own matching solver. Surplus prices itself: a third elite receiver
never wins a slot, so he adds nothing there while still being worth his full
market value above.

Roster mechanics are modelled rather than assumed, and getting this wrong is
not subtle. Cutting by trade value alone always reaches for the kicker, because
a kicker is the least valuable player on every roster — which empties the K slot
for fourteen weeks and reports a trade a team won as an eighty-point loss. Both
the cut and the waiver pickup are chosen by what they do to the lineup, scored
by making the move.

`npm run verify:trade` pins all of it: that the currency is additive, that a bye
costs exactly one week, that a scarce position outprices an abundant one at
identical output, that the drop keeps the only kicker, and that a planted
reliability slope is recovered.

### Draft grades

The measure is deliberately not "who took the best players" — that is mostly a
restatement of who picked first. Each pick is scored against the pick it *cost*:
ESPN publishes an average draft position drawn from millions of drafts, so the
gap between where a player went here and where he goes on average is a real
number. A team's grade is the **median** of those gaps, not the mean — one pick
taken forty slots late carries a mean and turns a draft grade into a
single-pick story.

Two things it cannot tell you, and does not pretend to: ADP is the market's
opinion rather than an outcome, and a pick's Value Score before week one is built
largely from the same projections everyone else is reading.

## Deliberate differences from the app this descends from

- **No dynasty model.** Replaced with rest-of-season value; see above.
- **No per-player bias correction** — measured, not deferred. Damping is zero
  everywhere because fitting it on 2023–2024 and scoring 2025 improved nothing
  by more than a quarter of a percent.
- **No season switcher.** The league is in its first season. A control offering
  one option is furniture; its place in the header went to the thing that
  actually varies — how old the snapshot is.
- **Positions with no bench are scored on their starters alone.** Kicker and
  defence carry no backup, and counting an empty bench as a zero capped both at
  85% of their value for every team, permanently. `verify:power` caught this.
- **Optimal lineup reads forward as well as back.** Before kickoff it compares
  the lineup you are about to submit against the best available, rather than
  reporting every point on the roster as left on the bench.
- **Defence ratings start from three finished seasons, recency-weighted.** An
  index built over zero weeks rates every defence null, which would blank the
  matchup chip on every row for the first month. A single prior season is
  unbiased and very noisy, and the first month is exactly when a noisy defensive
  rating gets applied to every row on every page — so the bootstrap blends 2025,
  2024 and 2023 at weights 1, 0.45 and 0.20, with the older seasons acting as a
  regulariser rather than as an equal vote. On a held-out season that blend
  orders results better than the most recent season alone at five of six
  positions, including both positions where the opponent matters most:

  ```
  ordering the held-out season, by |correlation| with its residuals
  group    last season only     blended
  QB           0.0166            0.0125   single
  RB           0.0072            0.0106   blend
  WR          -0.0167           -0.0181   blend
  TE           0.0463            0.0605   blend
  K            0.0250            0.0546   blend
  DST          0.0915            0.1082   blend
  ```

  It is labelled, and replaced the moment this season can stand on its own.
- **The rank chips report last season until this one has been played.** Total,
  PPG and boom rate are measured over the season in progress, and in week one
  there is no season in progress — every row on every page read
  `Total — | PPG — | BR —`, which is a true statement about an unplayed season
  and a useless one to somebody drafting off what these players did last year.
  The chips now carry the last finished season, prefixed with its year, on the
  same four-week switch the defence ratings use and for the same reason.

  It switches as a set rather than per player. A rank is a statement about a
  *pool*, so `#4 of 61` from a full season and `#7 of 12` from three weeks of
  this one are not comparable numbers, and a list mixing them would read as one
  ordering while being two.

  Boom rate is the reason this is fitted offline rather than computed in the
  browser: it needs the weekly projection that preceded each game, and
  `history.json` ships the actuals alone. `seasonProduction` measures all three
  in `npm run fit:priors`, where the paired weeks live, and `priors.json` carries
  four numbers per player — 718 of them, for 11KB. Who each player is *ranked
  against* is still decided in the browser, against today's universe: a player
  the snapshot no longer lists must not sit between two who are being drafted.

## Running it

```bash
npm install
```

```bash
npm run snapshot
```

```bash
npm run dev
```

The development entry is `http://localhost:5174/`.

```bash
npm run serve
```

Serves the built `dist/` with a working Refresh button — see below.

```bash
npm run fit:priors
```

```bash
npm run verify:history
```

```bash
npm run verify
```

```bash
npm run verify:forecast
```

```bash
npm run verify:lineup
```

```bash
npm run verify:power
```

```bash
npm run fit:projection
```

```bash
npm run verify:projection
```

```bash
npm run verify:stat-ids
```

```bash
npm run verify:trade
```

```bash
npm run research:matchup
```

```bash
npm run research:forecast
```

```bash
npm run build
```

## Refresh actually refreshes

The button in the header used to mean "drop the IndexedDB cache and re-read the
same files", because that is all a static page can do: the league is private, and
`fetch` refuses to set the `Cookie` header ESPN requires. That is the whole
reason the snapshot exists.

Where the app is **served locally** — `npm run dev`, or `npm run serve` over the
built copy — the button now posts to `/api/refresh`, and that route runs
`scripts/snapshot.ts` in Node with the credentials it already reads from the
gitignored `.env`. About fifteen seconds later the page reloads onto genuinely
new ESPN data. Nothing about this puts a credential in the browser: the client
sends an empty POST and gets back a status.

An ordinary refresh does **not** refit the models, because it does not need to.
The fits read the league's scoring table, each player's position and the finished
seasons — none of which move when Sunday's scores come in — so a new snapshot
would leave two perfectly valid models looking stale purely because every file
carries the snapshot's stamp. Each fit therefore records a hash of its own
inputs, and `npm run restamp` carries a model onto a fresher snapshot only when
that hash still matches. Add a season, edit the scoring table or reclassify a
player and the hash differs, nothing is carried forward, and the refit is
demanded rather than skipped. The **& refit** control forces the full rebuild.

On GitHub Pages the button clears the local cache and reloads the newest
published snapshot. The authenticated ESPN pull happens in GitHub Actions — on
every push, on the football-aware schedule below, or from the workflow's **Run
workflow** control. The browser cannot safely trigger that pull itself because
doing so would require publishing a GitHub or ESPN credential.

The endpoint is unauthenticated and bound to loopback. It runs a fixed command
with no caller-supplied input, which is fine for something only this machine can
reach and is not fine anywhere else; it is mounted only by the dev server and by
`npm run serve`, and `apply: 'serve'` keeps it out of every build.

## Deploying

Pushing to `main` deploys via GitHub Actions (`.github/workflows/deploy.yml`).
Enable it once under **Settings → Pages → Source → GitHub Actions**, and add two
repository secrets:

| Secret | Where to get it |
|---|---|
| `ESPN_SWID` | DevTools → Application → Cookies → espn.com, including the braces |
| `ESPN_S2` | Same place |

Two secrets, however many leagues. The workflow pulls, fits and verifies each
league in turn, reading the list from `src/lib/leagues.ts` via `npm run leagues`
so adding a league is one edit in one file.

The same workflow refreshes the snapshot on a schedule that is deliberately
uneven — hourly through the American Sunday afternoon and evening, twice on
Monday and Thursday nights, once a day otherwise. ESPN's numbers only move when
football is being played, and an hourly cron all week would spend most of its
runs rewriting an identical file.

Every cron asks for `:23` rather than `:00`. GitHub runs scheduled workflows on
a best-effort queue and sheds load at the top of the hour, which is where almost
every cron in the world lands. At `:00` this workflow was getting about three of
every seven requested runs, each one to five hours late, and a Sunday evening
slate could go ten hours without a refresh. The odd minute is the same frequency
against a much shorter queue.

**Reload is not a pull.** On GitHub Pages the browser cannot reach ESPN — that is
the whole reason the snapshot exists — so Reload only re-reads the newest
snapshot Actions has published. When it reports a stale one, the fix is to run
the workflow, which Settings links to; a local `npm run dev` or `npm run serve`
has a real Refresh that pulls from ESPN there and then.

The production build writes a small entry page, content-hashed JavaScript and
CSS chunks, and the ESPN JSON snapshot into `dist/`. GitHub Pages serves those
files directly, and `HashRouter` means no server rewrite rules are required.
Snapshot requests bypass the browser HTTP cache; IndexedDB is keyed by
`generatedAt`, so Reload immediately adopts a newly deployed pull without
redownloading unchanged data.

## A note on the colour scale

Value scores and heatmaps use red → yellow → green. Positional ranks use distinct
teal, magenta and lime labels for Total, PPG and BR — three hues far enough apart
to separate at 11px, and none of them the red or green the boom/bust tones own, so
a rank never reads as a verdict. Nothing depends on colour alone:
every heatmap cell prints its value and offers a Table toggle, every chip prints
its score, every positional rank prints its label and number, and boom/bust always
ships an arrow icon plus a text label. Chart lines are the exception and use a
CVD-validated categorical pair, since a line cannot label every point.

## Keyboard and assistive technology

- **Phone navigation.** Four primary destinations use full-width touch targets.
  More opens a native modal sheet with the remaining pages, Escape dismissal,
  and focus restoration. Changing pages returns to the top of the new content.
- **The player sheet is a real modal.** `aria-modal` says the page behind is
  inert but does nothing to the tab order, so focus is trapped inside the sheet
  and cycled at its edges. On close it returns to the row that opened it.
- **A skip link.** Seven nav tabs sit between the top of the document and the
  content on every navigation. The jump is done in JS rather than left to the
  `#main` href, because this app routes on the hash — the fragment navigation
  would be handed to the router as a route and move focus nowhere.
