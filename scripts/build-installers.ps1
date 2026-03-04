Write-Host "Building installers (Agent + Controller)..."
npm --workspace @rss/agent run tauri:build
npm --workspace @rss/controller run tauri:build
