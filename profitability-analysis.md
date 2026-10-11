# Why the bot loses money, and what to change

**Evidence base:** `trades-30d-latency-pnl.csv` — 3,210 copied trades, 3,199 settled,
$1 position size, 30 days. Every number below is computed from that file.

---

## 1. The headline

| | |
|---|---|
| Actual result | **−$126.86 on $3,211 invested = −3.95% ROI**, 43.6% win rate |
| Same trades, entered at the **target's** price | **+$513.61 = +15.99% ROI** |
| **Cost of our execution** | **$640 — 19.9 points of ROI** |

**The traders we copy are profitable. Our execution is what loses the money.**

We pay a mean **+5.1¢** over the target's entry price (median +3¢). On a mean entry
of $0.405 that is **12.6% of the cost of every position**. We pay more than the
target on **71%** of trades.

Breakeven therefore requires a copied trader whose real edge exceeds ~13%.
The best edge our research ever found was quickql at **+8%**. The strategy as
currently executed is **arithmetically incapable of profit** — no amount of trader
screening fixes that.

---

## 2. Two project beliefs the data contradicts

### "Only quickql is copyable"
It is the **worst** performer live, and its edge does not survive contact with reality.

| trader | n | actual ROI | ROI at target's price | execution cost | edge significant? |
|---|---:|---:|---:|---:|---|
| **RN1** | 2,905 | −4.2% | **+16.9%** | 21.0 pts | **YES** — 95% CI [+$0.104, +$0.240]/trade |
| swisstony | 167 | +11.0% | +20.9% | 9.9 pts | no (n too small) |
| quickql | 126 | −17.7% | **−9.7%** | 7.9 pts | no |

RN1 — which `CLAUDE.md` records as **failing** the screen — is the only wallet with a
statistically significant edge. quickql, the only wallet the screen **approved**, is
negative even before execution costs.

The first-entry backtest is mis-ranking traders. Re-validate it against this live
data before trusting it to pick anyone again.

### "We need to reduce latency"
We don't. Slippage is **flat across every latency bucket**:

| latency | n | mean slippage |
|---|---:|---:|
| 0–30 s | 224 | +4.5¢ |
| 30–90 s | 563 | +5.5¢ |
| 90–180 s | 932 | +4.8¢ |
| 180–300 s | 1,333 | +5.3¢ |
| 300–700 s | 147 | +5.2¢ |

Filling in 10 seconds instead of 169 would have changed nothing. The cost is **the
spread we cross as a taker**, not the delay. Speed work is wasted work.

---

## 3. Nothing in the current results is statistically significant

Bootstrap, 95% CI on mean P/L per $1 trade:

| | n | mean | 95% CI | verdict |
|---|---:|---:|---|---|
| ALL | 3,199 | −$0.0397 | [−$0.087, +$0.011] | indistinguishable from 0 |
| RN1 | 2,905 | −$0.0420 | [−$0.094, +$0.012] | indistinguishable from 0 |
| swisstony | 167 | +$0.1103 | [−$0.101, +$0.334] | indistinguishable from 0 |
| quickql | 126 | −$0.1769 | [−$0.352, +$0.011] | indistinguishable from 0 |

Binary-outcome P/L is extremely high-variance. **swisstony's +11% is noise** — do not
act on it. Any future change must be judged on ≥1,000 settled trades, not a good week.

---

## 4. No filter tuning rescues this

Every counterfactual filter over the real fills stays negative:

| filter | n | P/L | ROI |
|---|---:|---:|---:|
| ALL (what we did) | 3,199 | −$126.86 | −4.0% |
| fill price ≥ 0.10 | 3,041 | −$47.26 | −1.5% |
| fill price ≤ 0.70 | 2,845 | −$94.85 | −3.3% |
| band 0.20–0.70 | 2,390 | −$72.38 | −3.0% |
| band 0.20–0.70 + slippage ≤ +5¢ | 1,642 | −$28.72 | −1.7% |
| band 0.25–0.65 + slippage ≤ +3¢ | 1,165 | −$70.19 | −6.0% |

Tightening the price band is not the lever. Stop tuning it.

---

## 5. What to actually do, in order

### #1 — Replace FAK market orders with priced limit orders
**This is the only change that matters.** Everything else is rounding error.

Today `placeMarketBuy()` sends a market FAK and takes whatever the book offers —
that is a standing instruction to pay the spread on every entry.

Instead: post a **limit order at (or a defined tick above) the target's fill price**,
leave it live for a bounded window (e.g. 60–120 s — we already know delay is not
costly), then cancel if unfilled.

- Recovering even **half** the 20-point execution cost turns −4% into roughly +6%.
- Cost: a lower fill rate. Some misses will be adversely selected (the ones that ran
  away were the good ones), so the realised gain will be less than the full 20 points
  — but the margin is so large that it does not need to be close.
- Add a `max_slippage_ticks` config and record attempted-but-unfilled orders in
  `copy_signals` (`skip_reason='limit_no_fill'`) so the fill-rate/edge tradeoff is
  measurable rather than guessed.

### #2 — Stop copying on price-band rules alone; gate on liquidity
The spread is the cost, so screen the *market*, not just the price. Before ordering,
pull the book (`/book` or `/midpoint` + best bid/ask) and skip when the spread exceeds
a threshold. Thin illiquid markets are where the 10¢+ slippage lives — 664 of our
trades slipped more than 10¢.

### #3 — Re-validate the trader screen against live results
The backtest ranked quickql first and rejected RN1; live data says the opposite.
Until that is reconciled, the screen is not fit to choose targets. The likely culprits
are the two known data problems: the **prop-market resolution gap** (on-chain-only
resolution, so a large slice of sports markets is unscoreable) and **binary Yes/No
price ambiguity** (18.5% of live trades). Fix the CTF `payoutNumerators` reader first —
it is the biggest blind spot in the whole research loop.

### #4 — Only then scale size
At $1 per position, 30 days of trading produced a result indistinguishable from zero.
Do not raise `SIMPLE_POSITION_SIZE` to "make it meaningful" — that scales the loss.
Raise it only after limit-order execution has shown a positive edge over ≥1,000
settled trades.

---

## 6. Caveats, stated honestly

- The "+16% at target price" counterfactual assumes we would have filled at the
  target's price. We would not have filled every time; unfilled orders skew toward
  the trades that moved fastest, i.e. the best ones. Treat +16% as an **upper bound**
  on what perfect execution recovers, not a forecast.
- 81.5% of these trades are multi-outcome (named) markets where the recorded price is
  the true cost of the side bought, so the slippage measurement is sound for the bulk
  of the sample. The remaining 18.5% Yes/No trades carry the known price-ambiguity
  caveat.
- Win/loss is inferred from `pnl > 0`.
- Skipped signals are not in this file, so this measures the trades we **made**, not
  the opportunity cost of ones we declined.

---

## 7. Rule-enforcement gap found while auditing the ruleset

**The price band is checked against the TARGET's price, never against our own fill.**

`simple-copy-trader.ts` gates entries on `t.price` (the target's fill):

```ts
if (t.price < CONFIG.minPrice) skip('below_min_price')
if (t.price > CONFIG.maxPrice) skip('above_max_price')
```

Our own fill price is never checked — there is no max-slippage guard and no limit
price. Confirmed in the 30d data:

| | range observed |
|---|---|
| target price (what IS checked) | 0.050 – 0.700 — band held perfectly, 0 violations |
| **our fill price (never checked)** | **0.001 – 0.999** |

Consequences, all real settled money:

| | n | P/L | ROI |
|---|---:|---:|---:|
| target in-band but **our fill out of band** | 134 | **−$53.37** | **−39.2%** |
| our fill ≤ 0.05 (deep longshots) | 78 | −$51.42 | −65.3% |
| our fill ≥ 0.85 (favorites) | 69 | −$11.21 | −16.2% |
| our fill ≥ 0.95 | 27 | −$5.35 | −19.8% |

**134 trades — 4% of volume — account for $53 of the total $127 loss.** They were
bought under a rule that says we don't buy them. Adding a fill-price assertion is a
few lines and is independent of the larger limit-order rework in §5.

### Config discrepancy to verify on prod
The local `.env` reads `SIMPLE_MIN_PRICE=0.60`, `SIMPLE_MAX_PRICE=0.98` — the
*inverse* of the research band, and the exact "expensive favorites" profile
`CLAUDE.md` identifies as uncopyable. The 30d data proves the band actually in force
was **0.05–0.70**, so the local file is stale or an untested experiment. Confirm what
prod's `.env` holds before the next restart, since a restart would apply it.
