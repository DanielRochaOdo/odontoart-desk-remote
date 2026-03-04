Write-Host "Starting dev services..."
Start-Process powershell -ArgumentList "-NoProfile", "-Command", "npm --workspace server run dev"
Start-Process powershell -ArgumentList "-NoProfile", "-Command", "npm --workspace @rss/agent run dev"
Start-Process powershell -ArgumentList "-NoProfile", "-Command", "npm --workspace @rss/controller run dev"
