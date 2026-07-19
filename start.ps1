$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath ".env")) {
    throw ".env がありません。.env.example をコピーして設定してください。"
}

& cmd.exe /d /c npm.cmd start
if ($LASTEXITCODE -ne 0) {
    throw "Discord会議管理Botが終了しました (exit=$LASTEXITCODE)"
}
