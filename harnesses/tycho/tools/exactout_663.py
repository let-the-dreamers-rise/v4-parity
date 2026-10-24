# Independent big-int re-run of vector swap-1-663 (exact-out, zeroForOne) with v4 SwapMath
# semantics, once with v4's `>=` and once with tycho's `>` in the exact-out target check.
# Only the full-range position is in play (others are far away), so liquidity is constant.
Q96 = 1 << 96
def sqrt_at_tick(t):  # TickMath.getSqrtPriceAtTick
    a = abs(t)
    r = 0xfffcb933bd6fad37aa2d162d1a594001 if a & 1 else 1 << 128
    consts = [0xfff97272373d413259a46990580e213a,0xfff2e50f5f656932ef12357cf3c7fdcc,0xffe5caca7e10e4e61c3624eaa0941cd0,0xffcb9843d60f6159c9db58835c926644,0xff973b41fa98c081472e6896dfb254c0,0xff2ea16466c96a3843ec78b326b52861,0xfe5dee046a99a2a811c461f1969c3053,0xfcbe86c7900a88aedcffc83b479aa3a4,0xf987a7253ac413176f2b074cf7815e54,0xf3392b0822b70005940c7a398e4b70f3,0xe7159475a2c29b7443b29c7fa6e889d9,0xd097f3bdfd2022b8845ad8f792aa5825,0xa9f746462d870fdf8a65dc1f90e061e5,0x70d869a156d2a1b890bb3df62baf32f7,0x31be135f97d08fd981231505542fcfa6,0x9aa508b5b7a84e1c677de54f3e99bc9,0x5d6af8dedb81196699c329225ee604,0x2216e584f5fa1ea926041bedfe98,0x48a170391f7dc42444e8fa2]
    for i, c in enumerate(consts):
        if a & (1 << (i + 1)): r = (r * c) >> 128
    if t > 0: r = ((1 << 256) - 1) // r
    return (r >> 32) + (1 if r % (1 << 32) else 0)
def cdiv(a, b): return -(-a // b)
def amt0(a, b, L, up):
    a, b = min(a, b), max(a, b); n1 = L << 96; n2 = b - a
    return cdiv(cdiv(n1 * n2, b), a) if up else (n1 * n2 // b) // a
def amt1(a, b, L, up):
    a, b = min(a, b), max(a, b)
    return cdiv(L * (b - a), Q96) if up else L * (b - a) // Q96
def next_from_output_zfo(p, L, amt):  # amount1 out, rounding down price
    q = cdiv(amt * Q96, L)  # amount <= uint160 path: divRoundingUp(amount<<96, L)
    return p - q
def step(cur, tgt, L, rem, fee, ge):
    out = amt1(tgt, cur, L, False)
    if (rem >= out) if ge else (rem > out): nxt = tgt
    else:
        out = rem; nxt = next_from_output_zfo(cur, L, rem)
    if nxt != tgt or not ge: out = amt1(nxt, cur, L, False) if nxt != tgt else out
    ain = amt0(nxt, cur, L, True)
    if out > rem: out = rem
    f = cdiv(ain * fee, 10**6 - fee)
    return nxt, ain, out, f
def tick_at(p):
    lo, hi = -887272, 887272
    while lo < hi:
        m = (lo + hi + 1) // 2
        if sqrt_at_tick(m) <= p: lo = m
        else: hi = m - 1
    return lo
def run(ge):
    p = 78746127417646221981820; tick = -276447; L = 90316428; rem = 2; fee = 600
    lim = 16452077102379953636235; paid = 0
    while rem != 0 and p != lim:
        comp = tick // 1  # spacing 1
        word = comp >> 8
        nt = max(word << 8, -887272)  # no initialized tick in this word except far away
        sp_next = sqrt_at_tick(nt)
        tgt = lim if sp_next < lim else sp_next
        start = p
        p, ain, out, f = step(p, tgt, L, rem, fee, ge)
        rem -= out; paid += ain + f
        if p == sp_next: tick = nt - 1
        elif p != start: tick = tick_at(p)
    return paid, p, tick
print("v4 (>=):   amountIn=%d sqrtP=%d tick=%d" % run(True))
print("tycho (>): amountIn=%d sqrtP=%d tick=%d" % run(False))
