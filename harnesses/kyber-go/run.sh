#!/bin/sh
# Reproduce the KyberSwap v4 parity results. Run from this directory.
set -e
export PATH=/usr/local/go/bin:$PATH
S=../..
# 1. pinned target source
[ -d src/kyberswap-dex-lib ] || (mkdir -p src && cd src && git clone https://github.com/KyberNetwork/kyberswap-dex-lib && cd kyberswap-dex-lib && git checkout ec21cb6b8a811198dda0dcbe274f51dd1aac1241)
# 2. harness
(cd harness && go build -o harness . \
  && ./harness ../$S/vectors/units.json      ../report-units.json \
  && ./harness ../$S/vectors/swaps.json      ../report-swaps.json \
  && ./harness ../$S/vectors-nopf/swaps.json ../report-swaps-nopf.json \
  && go run ./repro)
# 3. diagnostic: float word walk disabled (confirms F6)
[ -d src/kyberswap-dex-lib-nofloat ] || (cp -r src/kyberswap-dex-lib src/kyberswap-dex-lib-nofloat && sed -i 's/^const floatWalkAfterWords = 16/const floatWalkAfterWords = 1 << 40/' src/kyberswap-dex-lib-nofloat/pkg/liquidity-source/uniswap/v3/word_walk_float.go)
(cd diag-nofloat && go build -o h . && ./h ../$S/vectors/swaps.json report-swaps.json && ./h ../$S/vectors-nopf/swaps.json report-swaps-nopf.json)
