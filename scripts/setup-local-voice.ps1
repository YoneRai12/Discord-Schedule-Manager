param(
  [string]$PythonPath = "python",
  [string]$ModelRepository = "Systran/faster-whisper-large-v3"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvRoot = Join-Path $ProjectRoot ".voice-venv"
$VenvPython = Join-Path $VenvRoot "Scripts\python.exe"
$ModelRoot = Join-Path $ProjectRoot "data\models\faster-whisper-large-v3"

function Invoke-Native {
  param([scriptblock]$Command)
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "native command failed (exit=$LASTEXITCODE)"
  }
}

if (-not (Test-Path -LiteralPath $VenvPython)) {
  Invoke-Native { & $PythonPath -m venv $VenvRoot }
}

Invoke-Native { & $VenvPython -m pip install --disable-pip-version-check -r (Join-Path $ProjectRoot "requirements-voice.txt") }
Invoke-Native { & $VenvPython (Join-Path $PSScriptRoot "download_voice_model.py") --repo $ModelRepository --output $ModelRoot }

Write-Output "voice_runtime_ready"
Write-Output "MEETING_VOICE_PYTHON_COMMAND=.voice-venv/Scripts/python.exe"
Write-Output "MEETING_VOICE_STT_MODEL=data/models/faster-whisper-large-v3"
