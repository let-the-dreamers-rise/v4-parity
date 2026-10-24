// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pool} from "v4-core/libraries/Pool.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {SwapMath} from "v4-core/libraries/SwapMath.sol";
import {ProtocolFeeLibrary} from "v4-core/libraries/ProtocolFeeLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";

/// @notice Reference oracle: exposes the exact v4-core code paths so off-chain
/// implementations can be checked against them. Every call runs on fresh storage
/// when invoked via eth_call, so scenarios never interfere with each other.
contract Oracle {
    using Pool for Pool.State;

    Pool.State internal pool;

    struct Position {
        int24 tickLower;
        int24 tickUpper;
        int128 liquidity;
    }

    struct Scenario {
        int24 tickSpacing;
        uint160 sqrtPriceX96;
        uint24 lpFee;
        uint24 protocolFee; // packed: low 12 bits zeroForOne, high 12 bits oneForZero
        Position[] positions;
        bool zeroForOne;
        int256 amountSpecified; // v4 convention: negative = exact input
        uint160 sqrtPriceLimitX96;
        uint24 lpFeeOverride; // 0 = none, otherwise must carry the 0x400000 flag
    }

    struct Outcome {
        int128 amount0;
        int128 amount1;
        uint256 amountToProtocol;
        uint24 swapFee;
        uint160 sqrtPriceX96;
        int24 tick;
        uint128 liquidity;
    }

    function swap(Scenario calldata s) external returns (Outcome memory o) {
        pool.initialize(s.sqrtPriceX96, s.lpFee);
        if (s.protocolFee != 0) pool.setProtocolFee(s.protocolFee);
        for (uint256 i; i < s.positions.length; i++) {
            pool.modifyLiquidity(
                Pool.ModifyLiquidityParams({
                    owner: address(this),
                    tickLower: s.positions[i].tickLower,
                    tickUpper: s.positions[i].tickUpper,
                    liquidityDelta: s.positions[i].liquidity,
                    tickSpacing: s.tickSpacing,
                    salt: bytes32(i)
                })
            );
        }
        (BalanceDelta d, uint256 toProtocol, uint24 swapFee, Pool.SwapResult memory r) = pool.swap(
            Pool.SwapParams({
                amountSpecified: s.amountSpecified,
                tickSpacing: s.tickSpacing,
                zeroForOne: s.zeroForOne,
                sqrtPriceLimitX96: s.sqrtPriceLimitX96,
                lpFeeOverride: s.lpFeeOverride
            })
        );
        o = Outcome(d.amount0(), d.amount1(), toProtocol, swapFee, r.sqrtPriceX96, r.tick, r.liquidity);
    }

    // Pool-independent state snapshot after liquidity setup, so targets get exactly
    // what an indexer would read on-chain (current tick, in-range liquidity).
    function stateAfterSetup(Scenario calldata s) external returns (int24 tick, uint128 liquidity) {
        pool.initialize(s.sqrtPriceX96, s.lpFee);
        for (uint256 i; i < s.positions.length; i++) {
            pool.modifyLiquidity(
                Pool.ModifyLiquidityParams({
                    owner: address(this),
                    tickLower: s.positions[i].tickLower,
                    tickUpper: s.positions[i].tickUpper,
                    liquidityDelta: s.positions[i].liquidity,
                    tickSpacing: s.tickSpacing,
                    salt: bytes32(i)
                })
            );
        }
        tick = pool.slot0.tick();
        liquidity = pool.liquidity;
    }

    function getSqrtPriceAtTick(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(tick);
    }

    function getTickAtSqrtPrice(uint160 p) external pure returns (int24) {
        return TickMath.getTickAtSqrtPrice(p);
    }

    function getAmount0Delta(uint160 a, uint160 b, uint128 l, bool up) external pure returns (uint256) {
        return SqrtPriceMath.getAmount0Delta(a, b, l, up);
    }

    function getAmount1Delta(uint160 a, uint160 b, uint128 l, bool up) external pure returns (uint256) {
        return SqrtPriceMath.getAmount1Delta(a, b, l, up);
    }

    function getNextSqrtPriceFromInput(uint160 p, uint128 l, uint256 a, bool z) external pure returns (uint160) {
        return SqrtPriceMath.getNextSqrtPriceFromInput(p, l, a, z);
    }

    function getNextSqrtPriceFromOutput(uint160 p, uint128 l, uint256 a, bool z) external pure returns (uint160) {
        return SqrtPriceMath.getNextSqrtPriceFromOutput(p, l, a, z);
    }

    function computeSwapStep(uint160 cur, uint160 target, uint128 l, int256 rem, uint24 fee)
        external
        pure
        returns (uint160, uint256, uint256, uint256)
    {
        return SwapMath.computeSwapStep(cur, target, l, rem, fee);
    }

    function calculateSwapFee(uint16 protocolFee, uint24 lpFee) external pure returns (uint24) {
        return ProtocolFeeLibrary.calculateSwapFee(protocolFee, lpFee);
    }
}
