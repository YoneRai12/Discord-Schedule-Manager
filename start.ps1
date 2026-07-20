$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath ".env")) {
    throw ".env がありません。.env.example をコピーして設定してください。"
}

$Node = Get-Command "node.exe" -ErrorAction Stop
$Npm = Get-Command "npm.cmd" -ErrorAction Stop
$NodeMajor = [int](& ($Node.Source) -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 24) {
    throw "Node.js 24以上が必要です。現在のメジャーバージョン: $NodeMajor"
}

& ($Npm.Source) start
if ($LASTEXITCODE -ne 0) {
    throw "Discord会議管理Botが終了しました (exit=$LASTEXITCODE)"
}
