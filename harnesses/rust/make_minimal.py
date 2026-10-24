#!/usr/bin/env python3
"""Builds hand-made minimal repro vectors and fills `expect` by calling the v4-parity Oracle
(real v4-core Pool.swap) deployed on a local anvil. Usage: make_minimal.py <cast> <rpc> <oracle> <out.json>"""
import json, subprocess, sys

CAST, RPC, ORACLE, OUT = sys.argv[1:5]
MIN_SQRT = 4295128739
MAX_SQRT = 1461446703485210103287273052203988822378723970342
Q96 = 2**96
SIG = "swap((int24,uint160,uint24,uint24,(int24,int24,int128)[],bool,int256,uint160,uint24))((int128,int128,uint256,uint24,uint160,int24,uint128))"
SETUP = "stateAfterSetup((int24,uint160,uint24,uint24,(int24,int24,int128)[],bool,int256,uint160,uint24))(int24,uint128)"


def cast_call(sig, tup):
    r = subprocess.run([CAST, "call", "--rpc-url", RPC, ORACLE, sig, tup], capture_output=True, text=True)
    if r.returncode != 0:
        return None, r.stderr.strip().splitlines()[-1] if r.stderr else "revert"
    return r.stdout.strip(), None


def strip(x):
    return x.split(" ")[0]


def case(id_, ts, lp, pf0, pf1, sqrt, positions, zfo, amt, limit=None, ovr=0, note=""):
    if limit is None:
        limit = MIN_SQRT + 1 if zfo else MAX_SQRT - 1
    pos = ",".join(f"({a},{b},{l})" for a, b, l in positions)
    tup = f"({ts},{sqrt},{lp},{(pf1 << 12) | pf0},[{pos}],{str(zfo).lower()},{amt},{limit},{ovr})"
    st, err = cast_call(SETUP, tup)
    assert err is None, err
    tick, liq = [strip(x) for x in st.splitlines()]
    out, err = cast_call(SIG, tup)
    v = {"id": id_, "note": note,
         "pool": {"tickSpacing": ts, "lpFee": lp, "protocolFeeZeroForOne": pf0, "protocolFeeOneForZero": pf1,
                  "sqrtPriceX96": str(sqrt), "tick": int(tick), "liquidity": liq,
                  "positions": [{"tickLower": a, "tickUpper": b, "liquidity": str(l)} for a, b, l in positions]},
         "swap": {"zeroForOne": zfo, "amountSpecified": str(amt), "sqrtPriceLimitX96": str(limit), "lpFeeOverride": ovr}}
    if err:
        v["expect"] = {"revert": err}
    else:
        f = [strip(x) for x in out.strip("()").split(", ")]
        v["expect"] = {"amount0": f[0], "amount1": f[1], "amountToProtocol": f[2], "swapFee": int(f[3]),
                       "sqrtPriceX96": f[4], "tick": int(f[5]), "liquidity": f[6]}
    return v


FR = (-887220, 887220)
L = 10**21
vs = [
    case("min-pf-3000-1000-exactIn", 60, 3000, 1000, 1000, Q96, [(*FR, L)], True, -10**18,
         note="0.30% pool, protocol fee 1000 pips (0.10%) both directions, exact-in 1e18 token0"),
    case("min-pf0-control", 60, 3000, 0, 0, Q96, [(*FR, L)], True, -10**18, note="same, protocol fee off"),
    case("min-pf-500-500-exactOut", 10, 500, 500, 500, Q96, [(-887270, 887270, L)], False, 10**18,
         note="0.05% pool, protocol fee 500 pips, exact-out 1e18 token0"),
    case("min-pf-100-50-exactIn", 1, 100, 50, 50, Q96, [(-887272, 887272, L)], False, -10**18,
         note="0.01% pool, protocol fee 50 pips, exact-in token1"),
    # tick-boundary state: v4 slot0 after a zeroForOne swap that stops exactly at tick 0 is (sqrt(0), tick=-1, L=0);
    # for a oneForZero follow-up that is equivalent to a fresh pool at sqrt(0) (tick 0, L in range)
    case("chain-truth-oneForZero-from-tick0", 60, 3000, 0, 0, Q96, [(0, 600, 10**18)], False, -10**15,
         note="ground truth for the 2nd swap of the chained-quote probe"),
    case("lpfee-1e6-exactIn", 60, 1000000, 0, 0, Q96, [(*FR, L)], True, -10**18, note="static 100% LP fee pool"),
]
json.dump({"generator": "make_minimal.py (rust harness)", "vectors": vs}, open(OUT, "w"), indent=1)
print(json.dumps(vs, indent=1))
