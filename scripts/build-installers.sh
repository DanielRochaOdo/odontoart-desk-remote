#!/usr/bin/env bash
set -euo pipefail

npm --workspace @rss/agent run tauri:build
npm --workspace @rss/controller run tauri:build
