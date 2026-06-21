# Aura Gold Alerts — The Complete Trading Tutorial

### How to read the system's signals and enter trades like a professional

This is your field manual. It starts at zero (what a candle is) and ends at master level
(how to combine the system's DAT score, regime, drive label, and liquidity read into one
high-probability decision). Read it once end to end. Then keep it beside your screen.

> **The one promise this document makes:** there is no 90% win-rate system, and anyone who
> sells you one is lying. A well-filtered confluence system like this one realistically wins
> **55–70%** of trades — and *that is enough to be very profitable* if your winners are bigger
> than your losers and you never break the risk rules in Chapter 9. Accuracy comes from
> **patience and selection**, not from trading more. Most of this manual is about what *not*
> to trade.

---

# Part 1 — The Foundation (start here)

## 1. What a candle actually tells you

Every candle is one unit of time (on M5, one candle = 5 minutes). It records four prices:
**Open, High, Low, Close** — "OHLC". The shape of the candle is a story about who won that
fight: buyers or sellers.

```
   BULLISH (close > open)        BEARISH (close < open)
   price went UP                 price went DOWN

         │  ← high (wick)              │  ← high (wick)
        ┌┴┐ ← close                   ┌┴┐ ← open
        │ │                           │ │
        │ │  body = open→close        │ │   body = open→close
        │ │                           │ │
        └┬┘ ← open                    └┬┘ ← close
         │  ← low (wick)               │  ← low (wick)
       (green / hollow)              (red / filled)
```

Two parts, two meanings:

- **The body** (open→close) = who *won*. A big body = strong conviction. A tiny body = a draw.
- **The wicks** (the thin lines) = where price went but got *rejected*. A long wick = price
  tried to go there and was slammed back. Wicks are where the system reads **liquidity** and
  **rejection** (Chapter 5).

**Master note:** the close is the only price that "counts" as a decision. Wicks lie; closes
commit. This is why every structural rule in the system (BOS, sweep) is **close-confirmed** —
it ignores wick fakery and waits for a candle to actually *close* past a level.

## 2. The candle patterns the system scores

You do not need to memorize 100 patterns. The system reads a handful that actually move money.
Here are the ones it scores, drawn so you can spot them on the chart.

### Pin bar / Hammer (bullish rejection)

```
        │
        │      A long lower wick = sellers pushed price DOWN hard,
       ┌┴┐     then buyers rejected it and slammed it back up.
       └┬┘     Body small, at the TOP. Wick at least 2x the body.
        │
        │      → "Bottoming tail." Buyers are defending this level.
        │      Best when it forms AT a demand zone or after a sweep.
        │
```

### Shooting star (bearish rejection) — the mirror image

```
        │
        │      Long UPPER wick = buyers pushed up, sellers rejected
        │      and drove it back down. Body small, at the BOTTOM.
       ┌┴┐
       └┬┘     → "Topping tail." Sellers are defending. Bearish.
        │
```

### Doji (indecision)

```
        │
       ─┼─     Open ≈ close. A cross. Nobody won.
        │      At the END of a trend = momentum is stalling (warning).
              In the MIDDLE of chop = noise, ignore.
```

### Engulfing (momentum shift)

```
   Bullish engulfing:           A small candle, then a BIG opposite
                                 candle that completely "eats" the
     ┌┐                          previous body. The market just
   ┌─┘│  ← big green body        changed hands with force.
   │  └┐    swallows the         → Bullish engulfing after a pullback
   │ ┌─┘    small red one          = continuation trigger.
   └─┘
```

**The beginner trap:** a big red candle is *not* automatically "the market is collapsing."
Size is relative. The system measures every candle's body against **ATR** (average true range
— the recent typical candle size). A "big" candle is one that is big *for this market right
now*. You should think the same way: compare every candle to its neighbors, not to your fear.

---

# Part 2 — How the System Thinks

## 3. The three questions every trade must answer (the DAT framework)

This is the heart of the system. Before any signal fires, the engine asks three questions in
order. It calls this **DAT: Direction, Area, Trigger.** A trade only qualifies when it has
enough of them. You should ask these same three questions, every time, in this order.

| Step | Question | What the system checks | What YOU look for |
|---|---|---|---|
| **D — Direction** | *Which way is the big picture?* | Higher-timeframe bias (H4/H1 trend). Never trade against a clearly trending H4. | Is the daily/4h trend up or down? Trade *with* it. |
| **A — Area** | *Are we at a place worth trading from?* | Order block, support/resistance, OTE/fib zone, fair-value-gap retest. | Is price AT a meaningful level, not floating in the middle of nowhere? |
| **T — Trigger** | *Has price actually shown its hand?* | A trigger candle (pin/engulfing) OR a structural break (BOS/sweep). | Did a candle just confirm the move, or are you guessing? |

The system shows you a **DAT score: 0/3, 1/3, 2/3, or 3/3** on every signal.

- **3/3** = textbook. Direction, Area, and Trigger all aligned. These are your A+ setups.
- **2/3** (with Trigger present) = still tradable by default, slightly lower grade.
- **1/3 or 0/3** = the system says **No Trade**. Do not override it. This is the gate that
  saves you from yourself.

> **Master principle:** Direction tells you *which* side. Area tells you *where*. Trigger tells
> you *when*. Beginners get an opinion (Direction) and immediately enter. Professionals wait for
> all three. The gap between those two behaviors is most of the difference in your win rate.

## 4. Score, Grade, and Quality — what the numbers mean

Every signal carries a **score out of 100**. It is the sum of all confluences the engine found
(trend alignment, momentum, structure, volume surge, candle patterns, etc.) minus penalties.

| Score | Grade | What it means | Action |
|---|---|---|---|
| **90–100** | **A+ Setup** | Everything lines up. Rare. | Take it. Full planned risk. |
| **80–89** | **A Setup** | Strong, clean confluence. | Take it. Standard risk. |
| **65–79** | **B Setup** | Decent, but not perfect. | Take only if it fits your plan and risk budget. |
| **Below 65** | **No Trade** | Not enough edge. | **Skip. Always.** |

Two hard filters sit *underneath* the score and can veto a high number:

- **Net conviction** — if BUY score and SELL score are *both* high, the market is conflicted
  (two-sided). The system rejects it even if one side scores 80. A 80-vs-78 fight is noise.
  You want 80-vs-30: a clear winner.
- **Risk:Reward minimum** — the system will not present a trade whose realistic reward is less
  than **2x the risk** (1:2). If the nearest sensible target is too close to justify the stop,
  there is no trade. Reward must pay for the risk.

**Read it like this:** the *score* is how much the engine likes the setup. The *grade* is the
label. The *filters* are the bouncers at the door who can throw out a good-looking setup for
being secretly conflicted or having a lousy payoff. Respect all three.

## 5. The structural reads — liquidity, BOS, sweeps, zones

These are the "smart money" concepts the system computes for you. You don't have to draw them;
you have to *understand* them so the signal makes sense.

### Break of Structure (BOS) — the trend confirms

```
   Uptrend BOS (bullish):
                              ╱╲        ← price CLOSES above the
              ╱╲      ╱╲    ╱   ╲         previous swing high =
       ╱╲   ╱   ╲   ╱   ╲ ╱            structure broke UP.
      ╱   ╲╱     ╲ ╱  ▲ ← prior high   The uptrend is confirmed.
                  ╲╱
```

A BOS = price *closed* beyond the last significant swing point. It confirms the trend is
continuing. The system only counts a BOS on the **close**, never a wick. (You should too.)

### Liquidity sweep — the trap before the move

```
   Bullish sweep (stop hunt below, then reversal):

       ╱╲          ╱╲       Price dips BELOW an obvious low
      ╱  ╲   ╱╲   ╱  ╲      (where everyone's stop-losses sit),
     ╱    ╲ ╱  ╲ ╱         grabs that liquidity, then SNAPS
            ╲╱  ↓          back up and closes above the low.
         prior low  ← wick pierces, close back inside
                            → "They ran the stops." Reversal fuel.
```

This is what Fabio (the pro scalper) calls the "shakeout" and what the system labels a
**liquidity sweep**: a wick pierces a level where orders are resting, then closes back inside.
It is one of the highest-quality triggers because it shows weak hands were just flushed out.

### Demand / Supply zone (order block) + Imbalance (FVG)

```
   Demand zone = the last down-candle before a strong up-move.
   Price often RETURNS to it before continuing. Buy the return.

   Fair Value Gap (FVG) / imbalance = a price gap left by a fast
   move, where one side was far more aggressive. Price tends to
   come back and "fill" part of it. A zone + an unfilled FVG
   pointing the same way = a high-quality entry area.
```

### Premium / Discount — are you buying cheap or expensive?

```
   Take the recent range. Split it in half.

   ┌──────────────── range high
   │   PREMIUM  (>55%)   → only look for SELLS here (expensive)
   ├──────────────── 50% = equilibrium
   │   DISCOUNT (<45%)   → only look for BUYS here (cheap)
   └──────────────── range low
```

**Master principle (and a direct lesson from the pro):** "buy low, sell high" only means
something *relative to value*. The system's premium/discount tells you where price sits in its
own range. Buying in discount and selling in premium stacks the odds. Buying in premium because
"it's going up" is how beginners donate money.

## 6. Regime — the market has moods, and most of them are untradeable

The single biggest reason beginners lose is trading the wrong setup in the wrong *regime*. The
system measures regime with **ADX** (a trend-strength gauge) and labels it:

| Regime | ADX | What's happening | What works |
|---|---|---|---|
| **Trending** | ≥ 25 | Strong directional push. | Trend/breakout/continuation setups. |
| **Developing** | 20–25 | Transitional, unclear. | Caution. Manage, don't initiate. |
| **Ranging** | < 20 | Chop. Price oscillating, going nowhere. | Almost nothing. The system *raises* the bar by +15 points before it'll allow a trade here. |

> **This is the lock that keeps you out of the casino.** When the system says *Ranging*, it is
> telling you the market is in **balance** — fair value, two-sided, fakeout city. The pro's exact
> words: in these conditions "out of balance, back inside balance, out of balance, back inside —
> this is called fake-outs." The discipline is simple and brutal: **do not initiate trend trades
> in a ranging regime.** Wait for the market to commit.

---

# Part 3 — Making the Trade

## 7. The Drive label — never take the first drive

This is the advisory the system added straight from the world-class scalper's playbook. When
price breaks out of a range, the system labels the move:

```
   FIRST DRIVE (amber — "wait"):

      range top ────┬─────────  price breaks out the FIRST time.
              ╱╲   ╱            Often a fakeout. The pro's rule:
       ╱╲   ╱  ╲ ╱             "Never take the first drive."
   ───╯  ╲ ╱    ╳ ← first break  → DO NOT chase. Wait.

   SECOND DRIVE (green — "go"):

      range top ──┬───────┬────  first break FAILED or pulled back,
            ╱╲   ╱ ╲     ╱        then price drives again. THIS is
       ╱╲  ╱  ╲ ╱   ╲   ╱        the move you want — confirmed,
   ───╯ ╲ ╱    ╳     ╲ ╱         weak hands already flushed.
         ╳  fail→     ╳ ← second drive ✓
```

- **"1st drive — wait"** (amber badge): the breakout is fresh and unconfirmed. High fakeout
  risk. The pro waits; so should you.
- **"2nd drive ✓"** (green badge, with *after shakeout* or *after retest*): price already tried
  once and either failed-then-redrove (shakeout) or pulled back and retested. This is the
  higher-quality entry.

**Honesty note (this matters):** we backtested turning this into a hard *filter* on your real
gold/forex data. It cut signal count by 25–40% and **modestly improved trade quality on some
pairs but lost net profit on XAU M5** — because your system already filters so hard (via DAT +
displacement + regime) that many "first drives" here are actually good. So the drive label is
**advisory, not a veto.** Use it as a tie-breaker and a "slow down" cue, not an automatic skip.

## 8. The three core setups (your playbook)

Everything above combines into three repeatable setups. Learn these cold. Trade *only* these.

### Setup A — The Pullback (continuation). Your bread and butter.

```
   Trend is UP (Direction ✓). Price extends, then pulls back to a
   demand zone / moving average (Area ✓). A bullish pin bar or
   engulfing forms there (Trigger ✓). DAT = 3/3.

        ╱╲          ┌ enter on the trigger candle's confirmation
       ╱  ╲   ╱╲   ╱   stop: below the pullback low
      ╱    ╲ ╱  ╲ ╱    target: prior high / next liquidity (≥2R)
     ╱      ╲╱ ← pullback to zone + pin bar
```

- **Best regime:** Trending. **Best location:** discount (for longs).
- **Why it wins:** you join an established trend at a *cheap* price with a *confirmation*.

### Setup B — The Breakout (second drive). For momentum days.

```
   Price coils in a tight range (base). It breaks out and CLOSES
   beyond the edge (BOS). You did NOT take the first break — you
   waited. It pulls back to the broken edge and drives again.

   ───┬─────────┬──── range top
      │ coil    │ ╱╲  enter on the 2nd-drive confirmation
      └─────────╯╱    stop: below the retest / broken edge
                      target: next liquidity pool (often big RR)
```

- **Best regime:** Trending / out-of-balance. **Drive label:** wait for "2nd drive ✓".
- **Why it wins:** the breakout proved itself and the retest gives you a tight stop.

### Setup C — The Shakeout (failed breakdown). The highest-RR setup.

```
   Price is at the lows of a range. Sellers push it BELOW support.
   The breakdown fails immediately — a long bottoming tail closes
   back inside (liquidity sweep). Buyers just trapped the sellers.

   ───────────────  support
        ╱╲    ╱╲
       ╱  ╲  ╱  ╲╱  ← closes back inside (sweep ✓)
   ─ ─ ╲ ─╲╱─ ─ ─ ─ wick pierces support then rejects
         ↓ sellers trapped → squeeze up
```

- **Best regime:** end of a range / out-of-balance shift. **Trigger:** liquidity sweep.
- **Why it wins:** trapped sellers must buy back, fueling an explosive move. Shakeouts often
  give the biggest reward-to-risk of any setup (3R+).

## 9. Risk management — the part that actually makes you money

You can have a mediocre strategy and great risk management and still win. The reverse is not
true. The system computes a full **risk plan** for every signal: entry, stop loss, three take
profits (TP1/TP2/TP3), suggested lot size, margin, and the cash value of your max loss. Use it.

**The non-negotiable rules (these come straight from the pro and are baked into the system):**

1. **Risk a fixed small % per trade.** 0.25%–0.5% of the account is the professional range. Never
   "feel out" a bigger size because you're confident. Confidence is not edge.
2. **The 2% daily stop.** The system tracks your settled R for the day. If you lose **2R** (about
   2% at 1% risk, or your 8-small-stops day), **you are done for the day.** Close the laptop.
   This single rule prevents the blow-up that ends most trading careers.
3. **Be wrong immediately.** If the trade goes against you right away, take the small stop. Do
   *not* widen the stop "because it'll come back." Widening stops is how accounts die.
4. **Move to break-even fast.** Once price moves in your favor and confirms (e.g., a second push
   / BOS in your direction), move your stop to entry. Now the trade is *free*. The pro does this
   constantly — it's why his drawdowns stay tiny.
5. **Take partials. You can never go broke taking profit.** Scale out at TP1, let a runner go to
   TP2/TP3. Bank the win, remove the stress.
6. **Build profit, then risk profit.** Early in the session, trade small and bank wins. On a clear
   directional day, you can risk the *profit you already made* for a bigger run. You never risk
   the day's locked-in gains on a gamble.

> **Over-extension guard:** the system flags when price is more than **2× ATR** away from its
> moving average ("don't chase"). If you see that flag, the move is stretched. Wait for a
> pullback. Chasing extended price is buying the top.

## 10. The entry checklist — run this every single time

Before you click buy or sell, the answer to all of these must be yes. Tape it to your monitor.

```
  ☐  REGIME ok?      Not "Ranging" for a trend trade. (ADX ≥ 20+)
  ☐  DIRECTION?      With the H4/H1 bias, not against it.
  ☐  AREA?           At a real zone / S-R / discount-premium edge.
  ☐  TRIGGER?        A confirmation candle OR a close-confirmed
                     BOS/sweep. Not a guess, not a wick.
  ☐  DAT score?      3/3 ideal, 2/3 minimum. Never 1/3.
  ☐  GRADE?          A+/A/B only. Never "No Trade".
  ☐  DRIVE?          Prefer "2nd drive ✓". If "1st drive — wait",
                     slow down and demand extra confluence.
  ☐  RISK:REWARD?    At least 1:2. The system enforces this.
  ☐  EXTENSION?      Not flagged "don't chase" (>2 ATR from EMA).
  ☐  DAILY BUDGET?   You have NOT hit your 2R daily stop.
  ☐  NEWS?           No high-impact event about to print.
```

If every box is checked, take the trade with the planned risk and *manage it by the rules in
Chapter 9*. If even one box is unchecked, the correct action is **wait**. There is always
another trade. There is not always another account.

---

# Part 4 — Putting It Together

## 11. A full worked example (long)

Let's read a signal the way a professional does, start to finish.

1. **Context.** It's the New York session. Gold (XAUUSDm) on M5. The H4 trend is up — so your
   **Direction** is long only. (You will *not* short today no matter how tempting a dip looks.)
2. **The system fires a signal: BUY, Score 86, A Setup, DAT 3/3.** Good. Now you verify, you
   don't just click.
3. **Regime: Trending (ADX 27).** ✓ Trend setups are valid.
4. **Area: price pulled back into a demand zone, in discount (38%).** ✓ You're buying cheap, at
   a real level — not floating in the middle.
5. **Trigger: a bullish engulfing closed off the zone, and there was a liquidity sweep of the
   low just before.** ✓ Weak longs were flushed; buyers committed.
6. **Drive: "2nd drive ✓ (after shakeout)".** ✓ This is exactly the move you want — not the
   first break.
7. **Risk plan: entry 2340.0, stop 2337.0 (below the sweep low), TP1 2346, TP2 2352. RR 1:2 to
   1:4.** Stop is small and *structural* (below the level that must hold). Reward pays.
8. **Extension: not flagged.** ✓ Not chasing.
9. **Daily budget: fresh, 0 losses today.** ✓
10. **You take it.** 0.5% risk. Price moves up, breaks the next minor high → you **move stop to
    break-even** (trade is now free). At TP1 you **take half off**. You let the runner go toward
    TP2 and trail it under each new higher low. You bank a 1:3 day on one clean trade and stop.

That is the whole game. One A-grade, fully-confluent, well-managed trade beats ten impulsive ones.

## 12. The ten habits that separate winners from gamblers

1. **Trade the checklist, not your feelings.** The plan decides, not the adrenaline.
2. **Quality over quantity, always.** Fewer, better trades. The system is *built* to say no.
3. **Respect "No Trade" and "Ranging".** The skips are where the edge lives.
4. **Never take the first drive on a hunch.** Let the market prove itself.
5. **Be a good loser.** Small stop, no widening, no revenge trade.
6. **Bank partials. Move to break-even fast.** Make trades free, then let them run.
7. **One instrument, mastered.** The pro trades only NASDAQ; you focus on gold/your pairs. Depth
   beats breadth. You learn how *your* instrument behaves.
8. **Honor the 2% daily stop.** The day you ignore it is the day you give it all back.
9. **Journal every trade.** You only see your real mistakes when your mind is cold, after the
   session — never during it.
10. **Trust verification over stories.** The system shows you *why* (DAT, confluences, drive,
    rejection reasons). Read the why. A signal you don't understand is a signal you shouldn't take.

---

## Appendix — Glossary (plain English)

- **OHLC** — Open, High, Low, Close. The four prices of a candle.
- **ATR** — Average True Range. The market's recent "normal" candle size. Used to judge "big".
- **ADX** — trend-strength gauge. High = strong trend; low = chop. Drives the *regime* label.
- **DAT** — Direction / Area / Trigger. The system's 3-question trade test (score out of 3).
- **BOS** — Break of Structure. A close beyond the last swing = trend confirmed.
- **Liquidity sweep** — wick pierces a level full of stops, then closes back inside. A trap/flush.
- **Order block / Demand-Supply zone** — the candle before a strong move; price often returns to it.
- **FVG / Imbalance** — a gap from a fast one-sided move; price tends to come back and fill it.
- **Premium / Discount** — top / bottom half of the range. Sell premium, buy discount.
- **Drive (1st / 2nd)** — is this the fresh, risky breakout, or the confirmed re-drive?
- **R / R-multiple** — your risk unit. "2R" = twice what you risked. The 2% daily stop = 2R.
- **RR (Risk:Reward)** — reward divided by risk. The system requires at least 1:2.
- **TP1 / TP2 / TP3** — the three staged take-profit targets in the risk plan.

---

*Advisory only — not financial advice. This document explains how to read the Aura Gold Alerts
system; it does not guarantee any outcome. Markets carry risk. Trade the rules, manage the risk,
and protect the account first.*
