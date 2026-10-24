#!/usr/bin/env sh
# Builds tycho-simulation-vis: upstream tycho-simulation at the pinned commit plus vis.patch,
# which only widens visibility (pub(crate) -> pub) and adds thin wrappers. No logic changes.
set -e
cd "$(dirname "$0")"
[ -d tycho-simulation-vis ] || git clone https://github.com/propeller-heads/tycho-simulation tycho-simulation-vis
git -C tycho-simulation-vis checkout 092ffc62af7f1e5509c3874b542481a0d6e69bd5
git -C tycho-simulation-vis apply ../vis.patch
