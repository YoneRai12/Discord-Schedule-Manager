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

$RestartDelaysSeconds = @(5, 15, 30, 60, 120, 300)
$StableRuntimeSeconds = 600
$ConsecutiveShortRuns = 0

while ($true) {
    $StartedAt = [DateTimeOffset]::UtcNow
    & ($Npm.Source) start
    $ExitCode = $LASTEXITCODE
    $RuntimeSeconds = [Math]::Max(
        0,
        [int](([DateTimeOffset]::UtcNow - $StartedAt).TotalSeconds)
    )

    if ($RuntimeSeconds -ge $StableRuntimeSeconds) {
        $ConsecutiveShortRuns = 0
    } else {
        $ConsecutiveShortRuns += 1
    }

    $DelayIndex = [Math]::Min(
        [Math]::Max($ConsecutiveShortRuns - 1, 0),
        $RestartDelaysSeconds.Count - 1
    )
    $DelaySeconds = $RestartDelaysSeconds[$DelayIndex]
    Write-Warning "Discord会議管理Botが終了しました (exit=$ExitCode runtimeSeconds=$RuntimeSeconds)。${DelaySeconds}秒後に再起動します。"
    Start-Sleep -Seconds $DelaySeconds
}
