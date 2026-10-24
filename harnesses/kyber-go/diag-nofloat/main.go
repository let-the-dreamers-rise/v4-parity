// v4-parity harness for KyberSwap's Uniswap v4 pool simulator
// (github.com/KyberNetwork/kyberswap-dex-lib, pkg/liquidity-source/uniswap/v4, which delegates
// all swap math to pkg/liquidity-source/uniswap/v3).
//
// Usage: harness <swaps.json|units.json> [report.json]
package main

import (
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"sort"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/holiman/uint256"

	"github.com/KyberNetwork/kyberswap-dex-lib/pkg/entity"
	v3 "github.com/KyberNetwork/kyberswap-dex-lib/pkg/liquidity-source/uniswap/v3"
	v4 "github.com/KyberNetwork/kyberswap-dex-lib/pkg/liquidity-source/uniswap/v4"
	"github.com/KyberNetwork/kyberswap-dex-lib/pkg/source/pool"
	"github.com/KyberNetwork/kyberswap-dex-lib/pkg/valueobject"
)

const (
	tok0 = "0x0000000000000000000000000000000000000001"
	tok1 = "0x0000000000000000000000000000000000000002"
)

var (
	minSqrtP1 = uint256.NewInt(4295128740)
	maxSqrtM1 = uint256.MustFromDecimal("1461446703485210103287273052203988822378723970341")
	hugeRes   = new(big.Int).Lsh(big.NewInt(1), 250)
	// hook address with only the BeforeSwap permission bit (1<<7) set
	overrideHookAddr = common.HexToAddress("0x0000000000000000000000000000000000000080")
	curOverride      uint32
)

// ---------------- vector types ----------------

type Position struct {
	TickLower int    `json:"tickLower"`
	TickUpper int    `json:"tickUpper"`
	Liquidity string `json:"liquidity"`
}
type PoolV struct {
	TickSpacing int        `json:"tickSpacing"`
	LpFee       uint32     `json:"lpFee"`
	PF01        uint32     `json:"protocolFeeZeroForOne"`
	PF10        uint32     `json:"protocolFeeOneForZero"`
	SqrtPrice   string     `json:"sqrtPriceX96"`
	Tick        int        `json:"tick"`
	Liquidity   string     `json:"liquidity"`
	Positions   []Position `json:"positions"`
}
type SwapV struct {
	ZeroForOne bool   `json:"zeroForOne"`
	Amount     string `json:"amountSpecified"`
	Limit      string `json:"sqrtPriceLimitX96"`
	Override   uint32 `json:"lpFeeOverride"`
}
type Expect struct {
	Revert    string `json:"revert"`
	Amount0   string `json:"amount0"`
	Amount1   string `json:"amount1"`
	ToProto   string `json:"amountToProtocol"`
	SwapFee   uint32 `json:"swapFee"`
	SqrtPrice string `json:"sqrtPriceX96"`
	Tick      *int   `json:"tick"`
	Liquidity string `json:"liquidity"`
}
type SwapVec struct {
	ID     string `json:"id"`
	Pool   PoolV  `json:"pool"`
	Swap   SwapV  `json:"swap"`
	Expect Expect `json:"expect"`
}
type UnitVec struct {
	Fn     string            `json:"fn"`
	Args   []json.RawMessage `json:"args"`
	Expect json.RawMessage   `json:"expect"`
}

// ---------------- report ----------------

type Mismatch struct {
	ID       string `json:"id"`
	Mode     string `json:"mode,omitempty"`
	Field    string `json:"field"`
	Expected string `json:"expected"`
	Got      string `json:"got"`
	Note     string `json:"note,omitempty"`
}
type ModeReport struct {
	Counts      map[string]int `json:"counts"`
	ErrorKinds  map[string]int `json:"errorKinds,omitempty"`
	Unsupported map[string]int `json:"unsupportedReasons,omitempty"`
	MismatchBy  map[string]int `json:"mismatchByField,omitempty"`
	Mismatches  []Mismatch     `json:"mismatches"`
	Errors      []Mismatch     `json:"targetErrors"`
}

func newMR() *ModeReport {
	return &ModeReport{Counts: map[string]int{"PASS": 0, "MISMATCH": 0, "TARGET_ERROR": 0, "UNSUPPORTED": 0},
		ErrorKinds: map[string]int{}, Unsupported: map[string]int{}, MismatchBy: map[string]int{}}
}

// ---------------- helpers ----------------

func bi(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("bad int " + s)
	}
	return v
}

// calculateSwapFee exactly as pool_tracker.go:131-133 computes entity.Pool.SwapFee
func trackerSwapFee(protocolFee uint32, lpFee uint32) uint32 {
	pf, lp := uint64(protocolFee&0xfff), uint64(lpFee)
	return uint32(pf + lp - (pf * lp / 1_000_000))
}

// v4 ProtocolFeeLibrary.calculateSwapFee for a single direction
func v4SwapFee(pf, lp uint32) uint32 {
	if pf == 0 {
		return lp
	}
	return uint32(uint64(pf) + uint64(lp) - uint64(pf)*uint64(lp)/1_000_000)
}

func buildTicks(p PoolV) []v4.Tick {
	m := map[int]*v4.Tick{}
	for _, ps := range p.Positions {
		L := bi(ps.Liquidity)
		for _, side := range []struct {
			t   int
			neg bool
		}{{ps.TickLower, false}, {ps.TickUpper, true}} {
			t, ok := m[side.t]
			if !ok {
				t = &v4.Tick{Index: side.t, LiquidityGross: new(big.Int), LiquidityNet: new(big.Int)}
				m[side.t] = t
			}
			t.LiquidityGross.Add(t.LiquidityGross, L)
			if side.neg {
				t.LiquidityNet.Sub(t.LiquidityNet, L)
			} else {
				t.LiquidityNet.Add(t.LiquidityNet, L)
			}
		}
	}
	out := make([]v4.Tick, 0, len(m))
	for _, t := range m {
		if t.LiquidityGross.Sign() != 0 {
			out = append(out, *t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Index < out[j].Index })
	return out
}

type poolOpts struct {
	swapFee     uint32 // entity.Pool.SwapFee
	staticFee   uint32 // StaticExtra.Fee (PoolKey.fee)
	hook        common.Address
	realReserve bool // use tracker's EstimateReservesFromTicks reserves
}

func buildSim(p PoolV, o poolOpts) (*v4.PoolSimulator, error) {
	ticks := buildTicks(p)
	sqrtP := bi(p.SqrtPrice)
	tick := big.NewInt(int64(p.Tick))
	extra := v4.Extra{Extra: &v3.Extra{
		Liquidity: bi(p.Liquidity), TickSpacing: uint64(p.TickSpacing), SqrtPriceX96: sqrtP, Tick: tick, Ticks: ticks,
	}}
	eb, err := json.Marshal(extra)
	if err != nil {
		return nil, err
	}
	se := v4.StaticExtra{Fee: o.staticFee, TickSpacing: int32(p.TickSpacing), HooksAddress: o.hook}
	sb, _ := json.Marshal(se)
	var res entity.PoolReserves
	if o.realReserve {
		r0, r1 := v4.EstimateReservesFromTicks(sqrtP, ticks)
		res = entity.PoolReserves{r0.String(), r1.String()}
	} else {
		res = entity.PoolReserves{hugeRes.String(), hugeRes.String()}
	}
	ep := entity.Pool{
		Address: "0xpool", Exchange: "uniswap-v4", Type: v4.DexType, SwapFee: float64(o.swapFee),
		Reserves: res, Extra: string(eb), StaticExtra: string(sb),
		Tokens: []*entity.PoolToken{{Address: tok0, Decimals: 18, Swappable: true}, {Address: tok1, Decimals: 18, Swappable: true}},
	}
	return v4.NewPoolSimulator(ep, valueobject.ChainIDEthereum)
}

type outcome struct {
	amount0, amount1 *big.Int
	sqrtP            *uint256.Int
	tick             int
	liq              uint256.Int
	note             string
	claimed          *big.Int // exact-out partial fill: the output CalcAmountIn claims (nil if full fill)
}

// runSwap quotes one vector. viaWrapper=true goes through v4.PoolSimulator.CalcAmountOut/In (no
// price-limit parameter exists there); otherwise the embedded v3 simulator's *WithPriceLimit methods,
// which is exactly what the v4 wrapper delegates to for hookless pools, with the vector's limit.
func runSwap(sim *v4.PoolSimulator, s SwapV, viaWrapper bool) (*outcome, error) {
	amt := bi(s.Amount)
	exactIn := amt.Sign() < 0
	abs := new(big.Int).Abs(amt)
	tin, tout := tok0, tok1
	if !s.ZeroForOne {
		tin, tout = tok1, tok0
	}
	var limit uint256.Int
	limit.SetFromDecimal(s.Limit)
	o := &outcome{}
	var paid, recv *big.Int
	var si v3.SwapInfo
	if exactIn {
		param := pool.CalcAmountOutParams{TokenAmountIn: pool.TokenAmount{Token: tin, Amount: new(big.Int).Set(abs)}, TokenOut: tout}
		var r *pool.CalcAmountOutResult
		var err error
		if viaWrapper {
			r, err = sim.CalcAmountOut(param)
		} else {
			r, err = sim.PoolSimulator.CalcAmountOutWithPriceLimit(param, limit)
		}
		if err != nil {
			return nil, err
		}
		recv = r.TokenAmountOut.Amount
		paid = new(big.Int).Set(abs)
		if r.RemainingTokenAmountIn != nil && r.RemainingTokenAmountIn.Amount != nil {
			paid.Sub(paid, r.RemainingTokenAmountIn.Amount)
		}
		si = swapInfo(r.SwapInfo)
	} else {
		param := pool.CalcAmountInParams{TokenAmountOut: pool.TokenAmount{Token: tout, Amount: new(big.Int).Set(abs)}, TokenIn: tin}
		var r *pool.CalcAmountInResult
		var err error
		if viaWrapper {
			r, err = sim.CalcAmountIn(param)
		} else {
			r, err = sim.PoolSimulator.CalcAmountInWithPriceLimit(param, limit)
		}
		if err != nil {
			return nil, err
		}
		paid = r.TokenAmountIn.Amount
		// CalcAmountIn's result has no "amount actually delivered" field: it claims the full requested
		// output. Find out whether it really is a partial fill by re-running the same v3 Pool.Swap.
		recv = new(big.Int).Set(abs)
		var outU uint256.Int
		outU.SetFromBig(abs)
		lim := limit
		if viaWrapper {
			lim.Clear()
		}
		if sr, e2 := sim.V3Pool.GetInputAmountV2(s.ZeroForOne, outU, lim); e2 == nil && !sr.RemainingAmountIn.IsZero() {
			var rem uint256.Int
			rem.Neg(&sr.RemainingAmountIn)
			o.note = "CalcAmountIn partial fill: result claims full output " + abs.String()
			o.claimed = new(big.Int).Set(abs)
			recv = new(big.Int).Sub(abs, rem.ToBig())
		}
		si = swapInfo(r.SwapInfo)
	}
	if s.ZeroForOne {
		o.amount0, o.amount1 = new(big.Int).Neg(paid), recv
	} else {
		o.amount0, o.amount1 = recv, new(big.Int).Neg(paid)
	}
	o.sqrtP, o.tick, o.liq = si.NextStateSqrtRatioX96, si.NextStateTickCurrent, si.NextStateLiquidity
	return o, nil
}

func swapInfo(x any) v3.SwapInfo {
	switch t := x.(type) {
	case v4.SwapInfo:
		return t.PoolSwapInfo
	case v3.SwapInfo:
		return t
	}
	panic(fmt.Sprintf("unexpected swapinfo %T", x))
}

func errKind(err error) string {
	s := err.Error()
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}

func compare(mr *ModeReport, mode string, v SwapVec, o *outcome) {
	e := v.Expect
	var mm []Mismatch
	add := func(f, exp, got string) {
		if exp != got {
			mm = append(mm, Mismatch{ID: v.ID, Mode: mode, Field: f, Expected: exp, Got: got, Note: o.note})
		}
	}
	add("amount0", e.Amount0, o.amount0.String())
	add("amount1", e.Amount1, o.amount1.String())
	add("sqrtPriceX96", e.SqrtPrice, o.sqrtP.Dec())
	add("tick", fmt.Sprint(*e.Tick), fmt.Sprint(o.tick))
	add("liquidity", e.Liquidity, o.liq.Dec())
	if o.claimed != nil {
		recvExp := e.Amount1
		if !v.Swap.ZeroForOne {
			recvExp = e.Amount0
		}
		add("claimedOutput(partial fill)", recvExp, o.claimed.String())
	}
	if len(mm) == 0 {
		mr.Counts["PASS"]++
		return
	}
	mr.Counts["MISMATCH"]++
	for _, m := range mm {
		mr.MismatchBy[m.Field]++
	}
	mr.Mismatches = append(mr.Mismatches, mm...)
}

func targetErr(mr *ModeReport, mode string, v SwapVec, kind, detail string) {
	mr.Counts["TARGET_ERROR"]++
	mr.ErrorKinds[kind]++
	exp := "success"
	if v.Expect.Revert != "" {
		exp = "revert " + v.Expect.Revert
	} else {
		exp = fmt.Sprintf("success amount0=%s amount1=%s", v.Expect.Amount0, v.Expect.Amount1)
	}
	mr.Errors = append(mr.Errors, Mismatch{ID: v.ID, Mode: mode, Field: "outcome", Expected: exp, Got: detail})
}

func unsupported(mr *ModeReport, reason string) {
	mr.Counts["UNSUPPORTED"]++
	mr.Unsupported[reason]++
}

func isDefaultLimit(s SwapV) bool {
	var l uint256.Int
	l.SetFromDecimal(s.Limit)
	if s.ZeroForOne {
		return l.Eq(minSqrtP1)
	}
	return l.Eq(maxSqrtM1)
}

// ---------------- hook used for lpFeeOverride vectors (mode C) ----------------

type overrideHook struct{ *v4.BaseHook }

func (h *overrideHook) BeforeSwap(_ *v4.BeforeSwapParams) (*v4.BeforeSwapResult, error) {
	// A v4 hook's beforeSwap returns an LP-fee override; a Kyber hook reports it in SwapFee.
	return &v4.BeforeSwapResult{DeltaSpecified: new(big.Int), DeltaUnspecified: new(big.Int),
		SwapFee: v4.FeeAmount(curOverride)}, nil
}
func (h *overrideHook) CloneState() v4.Hook { return h }

// ---------------- swaps ----------------

func runSwaps(vs []SwapVec) map[string]*ModeReport {
	v4.RegisterHooks(&overrideHook{BaseHook: &v4.BaseHook{}}, overrideHookAddr)
	modes := map[string]*ModeReport{"A_integrator": newMR(), "B_math_isolated": newMR(), "C_override_hook": newMR()}
	for _, v := range vs {
		p, s := v.Pool, v.Swap
		dirPF := p.PF01
		if !s.ZeroForOne {
			dirPF = p.PF10
		}
		trackerFee := trackerSwapFee(p.PF01|p.PF10<<12, p.LpFee)
		for _, mode := range []string{"A_integrator", "B_math_isolated", "C_override_hook"} {
			mr := modes[mode]
			var opts poolOpts
			viaWrapper := false
			switch mode {
			case "A_integrator":
				if s.Override != 0 {
					unsupported(mr, "lpFeeOverride (hook dynamic fee) not expressible without a hook")
					continue
				}
				opts = poolOpts{swapFee: trackerFee, staticFee: p.LpFee, realReserve: true}
			case "B_math_isolated":
				if s.Override != 0 {
					unsupported(mr, "lpFeeOverride (hook dynamic fee) not expressible without a hook")
					continue
				}
				opts = poolOpts{swapFee: v4SwapFee(dirPF, p.LpFee), staticFee: p.LpFee}
			case "C_override_hook":
				if s.Override == 0 {
					unsupported(mr, "no lpFeeOverride in vector")
					continue
				}
				if !isDefaultLimit(s) {
					unsupported(mr, "v4 wrapper CalcAmountOut/In take no price limit")
					continue
				}
				curOverride = s.Override &^ 0x400000
				opts = poolOpts{swapFee: trackerFee, staticFee: 0x800000, hook: overrideHookAddr}
				viaWrapper = true
			}
			sim, err := buildSim(p, opts)
			if err != nil {
				if strings.Contains(err.Error(), "fee too high") {
					unsupported(mr, "fee >= 1e6 rejected by NewPool (math.go:57)")
					continue
				}
				if v.Expect.Revert != "" {
					mr.Counts["PASS"]++
					continue
				}
				targetErr(mr, mode, v, "construct: "+errKind(err), err.Error())
				continue
			}
			o, err := func() (o *outcome, err error) {
				defer func() {
					if r := recover(); r != nil {
						err = fmt.Errorf("panic: %v", r)
					}
				}()
				return runSwap(sim, s, viaWrapper)
			}()
			if v.Expect.Revert != "" {
				if err != nil {
					mr.Counts["PASS"]++
				} else {
					targetErr(mr, mode, v, "quoted where v4 reverts "+v.Expect.Revert,
						fmt.Sprintf("amount0=%s amount1=%s", o.amount0, o.amount1))
				}
				continue
			}
			if err != nil {
				k := errKind(err)
				if (v.Expect.Amount0 == "0" || v.Expect.Amount1 == "0") && strings.Contains(err.Error(), "zero") {
					k = "zero-output refused (v4 output 0): " + k
				}
				targetErr(mr, mode, v, k, err.Error())
				continue
			}
			compare(mr, mode, v, o)
		}
	}
	return modes
}

// ---------------- units ----------------

func argStr(r json.RawMessage) string {
	var s string
	if json.Unmarshal(r, &s) == nil {
		return s
	}
	return strings.TrimSpace(string(r))
}
func argBool(r json.RawMessage) bool { return strings.TrimSpace(string(r)) == "true" }
func u(r json.RawMessage) *uint256.Int {
	z, err := uint256.FromDecimal(argStr(r))
	if err != nil {
		panic(err)
	}
	return z
}

func runUnit(x UnitVec) (any, error) {
	a := x.Args
	switch x.Fn {
	case "getSqrtPriceAtTick":
		var t int
		fmt.Sscan(argStr(a[0]), &t)
		var r uint256.Int
		err := v3.GetSqrtRatioAtTick(t, &r)
		return r.Dec(), err
	case "getTickAtSqrtPrice":
		t, err := v3.GetTickAtSqrtRatio(u(a[0]))
		return fmt.Sprint(t), err
	case "getAmount0Delta", "getAmount1Delta":
		var r uint256.Int
		f := v3.GetAmount0DeltaV2
		if x.Fn == "getAmount1Delta" {
			f = v3.GetAmount1DeltaV2
		}
		err := f(u(a[0]), u(a[1]), u(a[2]), argBool(a[3]), &r)
		return r.Dec(), err
	case "getNextSqrtPriceFromInput", "getNextSqrtPriceFromOutput":
		var r uint256.Int
		f := v3.GetNextSqrtPriceFromInput
		if x.Fn == "getNextSqrtPriceFromOutput" {
			f = v3.GetNextSqrtPriceFromOutput
		}
		err := f(u(a[0]), u(a[1]), u(a[2]), argBool(a[3]), &r)
		return r.Dec(), err
	case "computeSwapStep":
		amt := bi(argStr(a[3]))
		amt.Neg(amt) // v4 sign (neg = exact in) -> v3/Kyber sign (pos = exact in)
		var rem uint256.Int
		if amt.Sign() < 0 {
			rem.SetFromBig(new(big.Int).Neg(amt))
			rem.Neg(&rem)
		} else {
			rem.SetFromBig(amt)
		}
		var fee uint64
		fmt.Sscan(argStr(a[4]), &fee)
		var nx, in, out, fa uint256.Int
		err := v3.ComputeSwapStep(u(a[0]), u(a[1]), u(a[2]), &rem, v3.FeeAmount(fee), &nx, &in, &out, &fa)
		return []string{nx.Dec(), in.Dec(), out.Dec(), fa.Dec()}, err
	case "calculateSwapFee":
		var pf, lp uint32
		fmt.Sscan(argStr(a[0]), &pf)
		fmt.Sscan(argStr(a[1]), &lp)
		return fmt.Sprint(trackerSwapFee(pf, lp)), nil
	}
	return nil, fmt.Errorf("unknown fn %s", x.Fn)
}

func runUnits(vs []UnitVec) map[string]*ModeReport {
	mr := newMR()
	byFn := map[string]map[string]int{}
	for i, x := range vs {
		id := fmt.Sprintf("unit-%d-%s", i, x.Fn)
		if byFn[x.Fn] == nil {
			byFn[x.Fn] = map[string]int{}
		}
		var expRev struct {
			Revert string `json:"revert"`
		}
		isRev := json.Unmarshal(x.Expect, &expRev) == nil && expRev.Revert != ""
		got, err := func() (g any, err error) {
			defer func() {
				if r := recover(); r != nil {
					err = fmt.Errorf("panic: %v", r)
				}
			}()
			return runUnit(x)
		}()
		status := ""
		if isRev {
			if err != nil {
				status = "PASS"
			} else {
				status = "TARGET_ERROR"
				mr.Errors = append(mr.Errors, Mismatch{ID: id, Field: "outcome", Expected: "revert " + expRev.Revert, Got: fmt.Sprint(got), Note: string(mustJSON(x.Args))})
			}
		} else if err != nil {
			status = "TARGET_ERROR"
			mr.ErrorKinds[x.Fn+": "+errKind(err)]++
			mr.Errors = append(mr.Errors, Mismatch{ID: id, Field: "outcome", Expected: string(x.Expect), Got: "error: " + err.Error(), Note: string(mustJSON(x.Args))})
		} else {
			var exp any
			json.Unmarshal(x.Expect, &exp)
			var expS string
			switch e := exp.(type) {
			case []any:
				ss := make([]string, len(e))
				for j, y := range e {
					ss[j] = fmt.Sprint(y)
				}
				expS = strings.Join(ss, ",")
			default:
				expS = argStr(x.Expect)
			}
			var gotS string
			if gs, ok := got.([]string); ok {
				gotS = strings.Join(gs, ",")
			} else {
				gotS = fmt.Sprint(got)
			}
			if expS == gotS {
				status = "PASS"
			} else {
				status = "MISMATCH"
				mr.MismatchBy[x.Fn]++
				mr.Mismatches = append(mr.Mismatches, Mismatch{ID: id, Field: x.Fn, Expected: expS, Got: gotS, Note: string(mustJSON(x.Args))})
			}
		}
		mr.Counts[status]++
		byFn[x.Fn][status]++
	}
	out := map[string]*ModeReport{"units": mr}
	for fn, c := range byFn {
		out["units:"+fn] = &ModeReport{Counts: c}
	}
	return out
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: harness <vectors.json> [report.json]")
		os.Exit(2)
	}
	outPath := "report.json"
	if len(os.Args) > 2 {
		outPath = os.Args[2]
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var probe struct {
		Vectors []json.RawMessage `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		panic(err)
	}
	var rep map[string]*ModeReport
	if len(probe.Vectors) > 0 && strings.Contains(string(probe.Vectors[0]), `"fn"`) {
		var f struct {
			Vectors []UnitVec `json:"vectors"`
		}
		json.Unmarshal(raw, &f)
		rep = runUnits(f.Vectors)
	} else {
		var f struct {
			Vectors []SwapVec `json:"vectors"`
		}
		json.Unmarshal(raw, &f)
		rep = runSwaps(f.Vectors)
	}
	keys := make([]string, 0, len(rep))
	for k := range rep {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		m := rep[k]
		fmt.Printf("%-28s PASS=%d MISMATCH=%d TARGET_ERROR=%d UNSUPPORTED=%d\n", k, m.Counts["PASS"], m.Counts["MISMATCH"], m.Counts["TARGET_ERROR"], m.Counts["UNSUPPORTED"])
		if len(m.ErrorKinds) > 0 {
			fmt.Printf("   errorKinds: %v\n", m.ErrorKinds)
		}
		if len(m.Unsupported) > 0 {
			fmt.Printf("   unsupported: %v\n", m.Unsupported)
		}
		if len(m.MismatchBy) > 0 {
			fmt.Printf("   mismatchByField: %v\n", m.MismatchBy)
		}
	}
	b, _ := json.MarshalIndent(map[string]any{
		"target":  "github.com/KyberNetwork/kyberswap-dex-lib@ec21cb6b8a811198dda0dcbe274f51dd1aac1241 (v0.134.47) pkg/liquidity-source/uniswap/v4",
		"vectors": os.Args[1], "modes": rep}, "", " ")
	os.WriteFile(outPath, b, 0o644)
}
