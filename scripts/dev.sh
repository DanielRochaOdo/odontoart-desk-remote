#!/usr/bin/env bash
set -euo pipefail

npm --workspace server run dev &
npm --workspace @rss/agent run dev &
npm --workspace @rss/controller run dev &
wait
