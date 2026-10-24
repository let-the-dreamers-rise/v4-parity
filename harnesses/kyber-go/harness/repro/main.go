// Minimal hand-built reproductions for FINDINGS.md. Run: go run ./repro
package main

import (
	"encoding/json"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/holiman/uint256"

	"github.com/KyberNetwork/kyberswap-dex-lib/pkg/entity"
	v3 "github.com/KyberNetwork/kyberswap-dex-lib/pkg/liquidity-source/uniswap/v3"
	v4 "github.com/KyberNetwork/kyberswap-dex-lib/pkg/liquidity-source/uniswap/v4"
	"github.com/KyberNetwork/kyberswap-dex-lib/pkg/source/pool"
	"github.com/KyberNetwork/kyberswap-dex-lib/pkg/valueobject"
)

const (
	t0 = "0x0000000000000000000000000000000000000001"
	t1 = "0x0000000000000000000000000000000000000002"
)

var hugeReserves bool // disables the simulator's reserve-based ErrInsufficientBalance guard

var q96 = new(big.Int).Lsh(big.NewInt(1), 96)

// exactly the tracker's formula, pool_tracker.go:131-133
func trackerSwapFee(slot0ProtocolFee, lpFee uint32) uint32 {
	pf, lp := uint64(slot0ProtocolFee&0xfff), uint64(lpFee)
	return uint32(pf + lp - (pf * lp / 1_000_000))
}

func mk(sqrtP *big.Int, tick int, L *big.Int, ts int, lo, hi int, swapFee, staticFee uint32, hook common.Address) *v4.PoolSimulator {
	ticks := []v4.Tick{
		{Index: lo, LiquidityGross: new(big.Int).Set(L), LiquidityNet: new(big.Int).Set(L)},
		{Index: hi, LiquidityGross: new(big.Int).Set(L), LiquidityNet: new(big.Int).Neg(L)},
	}
	eb, _ := json.Marshal(v4.Extra{Extra: &v3.Extra{Liquidity: L, TickSpacing: uint64(ts), SqrtPriceX96: sqrtP, Tick: big.NewInt(int64(tick)), Ticks: ticks}})
	sb, _ := json.Marshal(v4.StaticExtra{Fee: staticFee, TickSpacing: int32(ts), HooksAddress: hook})
	r0, r1 := v4.EstimateReservesFromTicks(sqrtP, ticks)
	if hugeReserves {
		r0 = new(big.Int).Lsh(big.NewInt(1), 250)
		r1 = r0
	}
	sim, err := v4.NewPoolSimulator(entity.Pool{Address: "0xp", Exchange: "uniswap-v4", Type: v4.DexType,
		SwapFee: float64(swapFee), Reserves: entity.PoolReserves{r0.String(), r1.String()}, Extra: string(eb), StaticExtra: string(sb),
		Tokens: []*entity.PoolToken{{Address: t0, Decimals: 18, Swappable: true}, {Address: t1, Decimals: 18, Swappable: true}}},
		valueobject.ChainIDEthereum)
	if err != nil {
		panic(err)
	}
	return sim
}

func out(sim *v4.PoolSimulator, in string, amt *big.Int, outTok string) string {
	r, err := sim.CalcAmountOut(pool.CalcAmountOutParams{TokenAmountIn: pool.TokenAmount{Token: in, Amount: amt}, TokenOut: outTok})
	if err != nil {
		return "error: " + err.Error()
	}
	return r.TokenAmountOut.Amount.String()
}

// v4 single-step exact-in oneForZero (no tick crossed): SwapMath.computeSwapStep + SqrtPriceMath, in big ints
func v4OneForZeroExactIn(sqrtP, L, amountIn *big.Int, swapFee int64) *big.Int {
	lessFee := new(big.Int).Div(new(big.Int).Mul(amountIn, big.NewInt(1_000_000-swapFee)), big.NewInt(1_000_000))
	next := new(big.Int).Add(sqrtP, new(big.Int).Div(new(big.Int).Lsh(lessFee, 96), L)) // getNextSqrtPriceFromAmount1RoundingDown(add)
	// getAmount0Delta(sqrtP, next, L, false) = floor(floor(L<<96 * (next-sqrtP) / next) / sqrtP)
	num := new(big.Int).Mul(new(big.Int).Lsh(L, 96), new(big.Int).Sub(next, sqrtP))
	return new(big.Int).Div(new(big.Int).Div(num, next), sqrtP)
}

type ovHook struct {
	*v4.BaseHook
	fee uint32
}

func (h *ovHook) BeforeSwap(*v4.BeforeSwapParams) (*v4.BeforeSwapResult, error) {
	return &v4.BeforeSwapResult{DeltaSpecified: new(big.Int), DeltaUnspecified: new(big.Int), SwapFee: v4.FeeAmount(h.fee)}, nil
}
func (h *ovHook) CloneState() v4.Hook { return h }

func main() {
	L := new(big.Int).Exp(big.NewInt(10), big.NewInt(24), nil)
	amt := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	lo, hi := -887220, 887220 // full range, tickSpacing 60

	fmt.Println("== F1: protocol fee direction (30 bps pool, price 1, L=1e24, exact-in 1e18 token1 -> token0) ==")
	for _, c := range []struct{ pf0, pf1 uint32 }{{0, 1000}, {1000, 0}, {500, 500}, {0, 0}} {
		slot0PF := c.pf1<<12 | c.pf0
		kfee := trackerSwapFee(slot0PF, 3000)
		sim := mk(new(big.Int).Set(q96), 0, L, 60, lo, hi, kfee, 3000, common.Address{})
		got := out(sim, t1, amt, t0)
		v4fee := int64(3000)
		if c.pf1 != 0 {
			v4fee = int64(c.pf1) + 3000 - int64(c.pf1)*3000/1_000_000
		}
		exp := v4OneForZeroExactIn(q96, L, amt, v4fee)
		g, _ := new(big.Int).SetString(got, 10)
		bps, _ := new(big.Float).Quo(new(big.Float).SetInt(new(big.Int).Mul(new(big.Int).Sub(g, exp), big.NewInt(10000))), new(big.Float).SetInt(exp)).Float64()
		fmt.Printf("protocolFee 0->1=%d 1->0=%d: kyber SwapFee=%d v4 swapFee(1->0)=%d  kyber out=%s v4 out=%s  diff=%+.2f bps\n",
			c.pf0, c.pf1, kfee, v4fee, got, exp, bps)
	}

	fmt.Println("\n== F2: hook LP-fee override drops protocol fee (dynamic-fee pool, override 3000, protocolFee 500/500) ==")
	hookAddr := common.HexToAddress("0x0000000000000000000000000000000000000080") // BeforeSwap permission bit
	h := &ovHook{BaseHook: &v4.BaseHook{}, fee: 3000}
	v4.RegisterHooks(h, hookAddr)
	slot0PF := uint32(500<<12 | 500)
	sim := mk(new(big.Int).Set(q96), 0, L, 60, lo, hi, trackerSwapFee(slot0PF, 3000), 0x800000, hookAddr)
	got := out(sim, t1, amt, t0)
	exp := v4OneForZeroExactIn(q96, L, amt, 500+3000-500*3000/1_000_000)
	fmt.Printf("kyber out=%s  v4 out (swapFee 3499)=%s  v4 out if no protocol fee=%s\n", got, exp, v4OneForZeroExactIn(q96, L, amt, 3000))
	h.fee = 0
	fmt.Printf("override=0 (v4: lpFee 0, swapFee=500): kyber out=%s  v4 out=%s\n", out(sim, t1, amt, t0), v4OneForZeroExactIn(q96, L, amt, 500))

	fmt.Println("\n== F3: pool sitting at MIN_SQRT_PRICE, zeroForOne quote via v4 wrapper (v4 reverts PriceLimitAlreadyExceeded) ==")
	minP := big.NewInt(4295128739)
	fmt.Println("(a) with tracker-estimated reserves:")
	hugeReserves = false
	sim2 := mk(minP, -887272, L, 1, -887272, 887272, 3000, 3000, common.Address{})
	fmt.Println("full-range L=1e24, ts=1, price=MIN: CalcAmountOut 1e18 token0 -> token1:", out(sim2, t0, amt, t1))
	r, err := sim2.CalcAmountIn(pool.CalcAmountInParams{TokenAmountOut: pool.TokenAmount{Token: t1, Amount: big.NewInt(1_000_000)}, TokenIn: t0})
	fmt.Println("(in-range) CalcAmountIn for 1e6 token1:", func() string {
		if err != nil {
			return "error " + err.Error()
		}
		return r.TokenAmountIn.Amount.String()
	}())

	fmt.Println("(b) with the reserve guard disabled (huge reserves), i.e. the swap math alone:")
	hugeReserves = true
	sim2 = mk(minP, -887272, L, 1, -887272, 887272, 3000, 3000, common.Address{})
	fmt.Println("CalcAmountOut 1e18 token0 -> token1:", out(sim2, t0, amt, t1))
	if r, err := sim2.CalcAmountIn(pool.CalcAmountInParams{TokenAmountOut: pool.TokenAmount{Token: t1, Amount: big.NewInt(1_000_000)}, TokenIn: t0}); err != nil {
		fmt.Println("CalcAmountIn error", err)
	} else {
		fmt.Printf("CalcAmountIn: pay %s token0 for 1000000 token1; SwapInfo next sqrtP=%s\n", r.TokenAmountIn.Amount, r.SwapInfo.(v4.SwapInfo).NextStateSqrtRatioX96.Dec())
	}
	hugeReserves = false

	fmt.Println("\n== F4: sqrtPriceLimit = MAX_SQRT_PRICE-1 rejected (MaxSqrtRatioU256 off by one) ==")
	var t int
	t, err = v3.GetTickAtSqrtRatio(uint256.MustFromDecimal("1461446703485210103287273052203988822378723970341"))
	fmt.Println("GetTickAtSqrtRatio(MAX_SQRT_PRICE-1):", t, err, "(v4: 887271)")
	sim = mk(new(big.Int).Set(q96), 0, big.NewInt(1000), 60, lo, hi, 3000, 3000, common.Address{})
	_, err = sim.PoolSimulator.CalcAmountOutWithPriceLimit(pool.CalcAmountOutParams{TokenAmountIn: pool.TokenAmount{Token: t1, Amount: amt}, TokenOut: t0},
		*uint256.MustFromDecimal("1461446703485210103287273052203988822378723970341"))
	fmt.Println("CalcAmountOutWithPriceLimit(oneForZero, limit MAX-1) on thin pool:", err)

	fmt.Println("\n== F5: exact-out partial fill reported as full fill (CalcAmountInWithPriceLimit; reserve guard disabled) ==")
	hugeReserves = true
	sim = mk(new(big.Int).Set(q96), 0, L, 60, lo, hi, 3000, 3000, common.Address{})
	var lim uint256.Int
	v3.GetSqrtRatioAtTick(-60, &lim)
	want := new(big.Int).Mul(amt, big.NewInt(1_000_000)) // 1e24 token1: far more than price can deliver before tick -60
	ri, err := sim.PoolSimulator.CalcAmountInWithPriceLimit(pool.CalcAmountInParams{TokenAmountOut: pool.TokenAmount{Token: t1, Amount: want}, TokenIn: t0}, lim)
	if err != nil {
		fmt.Println("error", err)
	} else {
		var w uint256.Int
		w.SetFromBig(want)
		sr, _ := sim.V3Pool.GetInputAmountV2(true, w, lim)
		var rem uint256.Int
		rem.Neg(&sr.RemainingAmountIn)
		fmt.Printf("requested out %s; result amountIn=%s, no remaining-output field; actually delivered=%s\n", want, ri.TokenAmountIn.Amount,
			new(big.Int).Sub(want, rem.ToBig()))
	}
}
