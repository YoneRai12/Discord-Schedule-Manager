[CmdletBinding()]
param(
    [ValidateSet("Register", "Verify", "Unregister")]
    [string]$Action = "Verify",

    [ValidatePattern("^[A-Za-z0-9._ -]{1,80}$")]
    [string]$TaskName = "DiscordMeetingManagerBot",

    [ValidateSet("Logon", "Both")]
    [string]$TriggerMode = "Both",

    [switch]$Replace,
    [switch]$ConfirmRemoval
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "このスクリプトはWindowsタスクスケジューラ専用です。"
}

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$StartScript = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "start.ps1"))
if (-not (Test-Path -LiteralPath $StartScript -PathType Leaf)) {
    throw "start.ps1 が見つかりません。"
}

$PowerShellExe = (Get-Command "powershell.exe" -ErrorAction Stop).Source
$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# Register-ScheduledTaskは存在しない独自フォルダーを作らないため、
# 初期状態のWindowsでも使えるルート直下へ一意なタスク名で登録する。
$TaskPath = "\"
$ExpectedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$StartScript`""

function Get-ExistingTask {
    Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
}

function Get-TriggerNames($Task) {
    @($Task.Triggers | ForEach-Object {
        switch ($_.CimClass.CimClassName) {
            "MSFT_TaskLogonTrigger" { "Logon" }
            "MSFT_TaskBootTrigger" { "Startup" }
            default { $_.CimClass.CimClassName }
        }
    })
}

function Resolve-AccountSid([string]$AccountName) {
    try {
        $Account = [Security.Principal.NTAccount]::new($AccountName)
        return $Account.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $null
    }
}

if ($Action -eq "Verify") {
    $Existing = Get-ExistingTask
    if (-not $Existing) {
        Write-Output "NOT_REGISTERED task=$TaskPath$TaskName"
        exit 2
    }
    $TaskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath
    $TaskAction = @($Existing.Actions)[0]
    $TriggerNames = Get-TriggerNames $Existing
    $ExpectedTriggers = if ($TriggerMode -eq "Both") { @("Logon", "Startup") } else { @("Logon") }
    $Problems = [Collections.Generic.List[string]]::new()
    if ([IO.Path]::GetFullPath($TaskAction.Execute) -ne [IO.Path]::GetFullPath($PowerShellExe)) {
        $Problems.Add("executable_mismatch")
    }
    if ($TaskAction.Arguments -ne $ExpectedArguments) { $Problems.Add("arguments_mismatch") }
    if ($TaskAction.WorkingDirectory -ne $ProjectRoot) { $Problems.Add("working_directory_mismatch") }
    foreach ($ExpectedTrigger in $ExpectedTriggers) {
        if ($TriggerNames -notcontains $ExpectedTrigger) { $Problems.Add("missing_$($ExpectedTrigger.ToLowerInvariant())_trigger") }
    }
    $TaskUserSid = Resolve-AccountSid $Existing.Principal.UserId
    if (-not $TaskUserSid -or $TaskUserSid -ne $CurrentUserSid) { $Problems.Add("user_mismatch") }
    if ($Problems.Count -gt 0) {
        Write-Output "MISMATCH task=$TaskPath$TaskName problems=$($Problems -join ',')"
        exit 3
    }
    Write-Output "OK task=$TaskPath$TaskName state=$($Existing.State) lastResult=$($TaskInfo.LastTaskResult) triggers=$($TriggerNames -join ',') user=$CurrentUser"
    exit 0
}

if ($Action -eq "Unregister") {
    if (-not $ConfirmRemoval) {
        throw "解除する場合は -ConfirmRemoval を付けてください。"
    }
    $Existing = Get-ExistingTask
    if (-not $Existing) {
        Write-Output "NOT_REGISTERED task=$TaskPath$TaskName"
        exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
    Write-Output "UNREGISTERED task=$TaskPath$TaskName"
    exit 0
}

$Existing = Get-ExistingTask
if ($Existing -and -not $Replace) {
    throw "同名タスクが既にあります。内容を確認し、置換する場合だけ -Replace を付けてください。"
}

$ScheduledAction = New-ScheduledTaskAction `
    -Execute $PowerShellExe `
    -Argument $ExpectedArguments `
    -WorkingDirectory $ProjectRoot
$Triggers = [Collections.Generic.List[object]]::new()
$Triggers.Add((New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser))
if ($TriggerMode -eq "Both") {
    $Triggers.Add((New-ScheduledTaskTrigger -AtStartup))
}
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal `
    -UserId $CurrentUser `
    -LogonType Interactive `
    -RunLevel Limited

try {
    $RegisterParameters = @{
        TaskName = $TaskName
        TaskPath = $TaskPath
        Action = $ScheduledAction
        Trigger = $Triggers.ToArray()
        Settings = $Settings
        Principal = $Principal
        Description = "Discord Meeting Manager Bot (no secrets stored in task arguments)"
    }
    if ($Existing) { $RegisterParameters.Force = $true }
    Register-ScheduledTask @RegisterParameters | Out-Null
} catch {
    throw "タスクを登録できませんでした。code=$($_.Exception.GetType().Name)"
}

Write-Output "REGISTERED task=$TaskPath$TaskName triggers=$TriggerMode user=$CurrentUser"
Write-Output "確認: powershell -NoProfile -ExecutionPolicy RemoteSigned -File `"$PSCommandPath`" -Action Verify -TaskName `"$TaskName`" -TriggerMode $TriggerMode"
