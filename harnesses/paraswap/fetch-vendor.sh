#!/usr/bin/env sh
# paraswap-dex-lib is not redistributed here. This copies the files the harness imports,
# unmodified, from the pinned commit. vendor/src/utils.ts is a shim of src/utils.ts:76-101
# (_require, stringifyWithBigInt) because the real file pulls in web3 and axios.
set -e
cd "$(dirname "$0")"
[ -d src-repo ] || git clone https://github.com/paraswap/paraswap-dex-lib src-repo
git -C src-repo checkout 291393f0f489b9fe9b0e2ddc3313724f4dbb5cd2
mkdir -p vendor/src/dex/uniswap-v4/hooks vendor/src/dex/uniswap-v3/contract-math
cp -r src-repo/src/dex/uniswap-v4/contract-math vendor/src/dex/uniswap-v4/
cp src-repo/src/dex/uniswap-v4/types.ts src-repo/src/dex/uniswap-v4/constants.ts vendor/src/dex/uniswap-v4/
cp src-repo/src/dex/uniswap-v4/hooks/types.ts vendor/src/dex/uniswap-v4/hooks/
cp src-repo/src/dex/uniswap-v3/contract-math/BitMath.ts vendor/src/dex/uniswap-v3/contract-math/
cp src-repo/src/bigint-constants.ts src-repo/src/constants.ts vendor/src/
cp utils-shim.ts vendor/src/utils.ts
