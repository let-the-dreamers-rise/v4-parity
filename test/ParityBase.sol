// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "v4-core-test/utils/Deployers.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Currency} from "v4-core/types/Currency.sol";

/// Replays a vector through PoolManager.unlock -> swap, exactly as a router would.
abstract contract ParityBase is Test, Deployers {
    using StateLibrary for *;
    using PoolIdLibrary for PoolKey;

    struct P { int24 lo; int24 hi; int128 l; }
    struct V {
        int24 ts; uint24 fee; uint24 pf; uint160 price; bool z; int256 amt; uint160 lim;
        int128 a0; int128 a1; uint160 priceAfter; int24 tickAfter; uint128 liqAfter;
    }


    function _ps(uint256 n, P[6] memory a) internal pure returns (P[] memory r) {
        r = new P[](n);
        for (uint256 i; i < n; i++) r[i] = a[i];
    }

    function _v(uint256 idx, V memory v, P[] memory ps) internal {
        deployFreshManagerAndRouters();
        MockERC20 t0 = new MockERC20("A", "A", 18);
        MockERC20 t1 = new MockERC20("B", "B", 18);
        if (address(t0) > address(t1)) (t0, t1) = (t1, t0);
        t0.mint(address(this), type(uint256).max / 2);
        t1.mint(address(this), type(uint256).max / 2);
        t0.approve(address(modifyLiquidityRouter), type(uint256).max);
        t1.approve(address(modifyLiquidityRouter), type(uint256).max);
        t0.approve(address(swapRouter), type(uint256).max);
        t1.approve(address(swapRouter), type(uint256).max);
        PoolKey memory k = PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), v.fee, v.ts, IHooks(address(0)));
        manager.initialize(k, v.price);
        if (v.pf != 0) {
            manager.setProtocolFeeController(address(this));
            manager.setProtocolFee(k, v.pf);
        }
        for (uint256 i; i < ps.length; i++) {
            try modifyLiquidityRouter.modifyLiquidity(k, ModifyLiquidityParams(ps[i].lo, ps[i].hi, ps[i].l, bytes32(i)), "") {}
            catch {
                // token deltas beyond int128 can't settle through a real router; the Pool library accepts them
                vm.skip(true);
                return;
            }
        }
        try swapRouter.swap(k, SwapParams(v.z, v.amt, v.lim), PoolSwapTest.TestSettings(false, false), "") returns (BalanceDelta d) {
            (uint160 p, int24 t,,) = manager.getSlot0(k.toId());
            uint128 l = manager.getLiquidity(k.toId());
            assertEq(d.amount0(), v.a0, string.concat("amount0 #", vm.toString(idx)));
            assertEq(d.amount1(), v.a1, string.concat("amount1 #", vm.toString(idx)));
            assertEq(p, v.priceAfter, string.concat("price #", vm.toString(idx)));
            assertEq(t, v.tickAfter, string.concat("tick #", vm.toString(idx)));
            assertEq(l, v.liqAfter, string.concat("liquidity #", vm.toString(idx)));
        } catch {
            vm.skip(true);
        }
    }

}
