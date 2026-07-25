[CmdletBinding()]
param(
    [ValidateSet("Register", "Verify", "Unregister")]
    [string]$Action = "Verify",

    [ValidatePattern("^[A-Za-z0-9._ -]{1,80}$")]
    [string]$TaskName = "DiscordMeetingManagerBot",

    [ValidateSet("Logon", "Both")]
    [string]$TriggerMode = "Logon",

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

function Test-IsAdministrator {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
    return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Action -eq "Verify") {
    $Existing = Get-ExistingTask
    if (-not $Existing) {
        Write-Output "NOT_REGISTERED task=$TaskPath$TaskName"
        exit 2
    }
    $TaskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath
    $TaskActions = @($Existing.Actions)
    $TaskAction = $TaskActions | Select-Object -First 1
    $TriggerNames = Get-TriggerNames $Existing
    $ExpectedTriggers = if ($TriggerMode -eq "Both") { @("Logon", "Startup") } else { @("Logon") }
    $Problems = [Collections.Generic.List[string]]::new()
    if ($TaskActions.Count -ne 1) { $Problems.Add("action_count_mismatch") }
    if ($TaskAction) {
        if ([IO.Path]::GetFullPath($TaskAction.Execute) -ne [IO.Path]::GetFullPath($PowerShellExe)) {
            $Problems.Add("executable_mismatch")
        }
        if ($TaskAction.Arguments -ne $ExpectedArguments) { $Problems.Add("arguments_mismatch") }
        if ($TaskAction.WorkingDirectory -ne $ProjectRoot) { $Problems.Add("working_directory_mismatch") }
    }
    foreach ($ExpectedTrigger in $ExpectedTriggers) {
        if ($TriggerNames -notcontains $ExpectedTrigger) { $Problems.Add("missing_$($ExpectedTrigger.ToLowerInvariant())_trigger") }
    }
    foreach ($TriggerName in $TriggerNames) {
        if ($ExpectedTriggers -notcontains $TriggerName) { $Problems.Add("unexpected_$($TriggerName.ToLowerInvariant())_trigger") }
    }
    $TaskUserSid = Resolve-AccountSid $Existing.Principal.UserId
    if (-not $TaskUserSid -or $TaskUserSid -ne $CurrentUserSid) { $Problems.Add("user_mismatch") }
    if ([string]$Existing.Principal.LogonType -ne "Interactive") { $Problems.Add("logon_type_mismatch") }
    if ([string]$Existing.Principal.RunLevel -ne "Limited") { $Problems.Add("run_level_mismatch") }
    if ([int]$Existing.Settings.RestartCount -ne 999) { $Problems.Add("restart_count_mismatch") }
    if ([string]$Existing.Settings.RestartInterval -ne "PT1M") { $Problems.Add("restart_interval_mismatch") }
    if ([string]$Existing.Settings.MultipleInstances -ne "IgnoreNew") { $Problems.Add("multiple_instances_mismatch") }
    if ([string]$Existing.Settings.ExecutionTimeLimit -ne "PT0S") { $Problems.Add("execution_time_limit_mismatch") }
    if (-not [bool]$Existing.Settings.StartWhenAvailable) { $Problems.Add("start_when_available_mismatch") }
    if ([bool]$Existing.Settings.DisallowStartIfOnBatteries) { $Problems.Add("battery_start_mismatch") }
    if ([bool]$Existing.Settings.StopIfGoingOnBatteries) { $Problems.Add("battery_stop_mismatch") }
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
if ($TriggerMode -eq "Both" -and -not (Test-IsAdministrator)) {
    throw "TriggerMode Both（PC起動時トリガーを含む）の登録には管理者権限が必要です。通常は既定のLogonを使用してください。"
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
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
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
    $ExceptionCode = $_.Exception.GetType().Name
    $ExceptionHResult = "0x{0:X8}" -f ($_.Exception.HResult -band 0xFFFFFFFFL)
    throw "タスクを登録できませんでした。code=$ExceptionCode hresult=$ExceptionHResult"
}

Write-Output "REGISTERED task=$TaskPath$TaskName triggers=$TriggerMode user=$CurrentUser"
Write-Output "確認: powershell -NoProfile -ExecutionPolicy RemoteSigned -File `"$PSCommandPath`" -Action Verify -TaskName `"$TaskName`" -TriggerMode $TriggerMode"
