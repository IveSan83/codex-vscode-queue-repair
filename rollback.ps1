$ErrorActionPreference = 'Stop'
& code --install-extension openai.chatgpt@26.917.62051 --force
if ($LASTEXITCODE -ne 0) { throw 'Official rollback installation failed' }
Write-Output 'Official 26.917.62051 installed. Close every VS Code window and reopen.'
Write-Output 'The repair journal is retained. It is not automatically replayed or imported into the official extension.'
