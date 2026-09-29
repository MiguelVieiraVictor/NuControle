# Gera dist\NuControle.exe (um arquivo so, nao exige Python instalado).
#   powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

python -m pip install --quiet -r requirements.txt pyinstaller
python testes.py
if ($LASTEXITCODE -ne 0) { throw "Testes falharam; build cancelado." }

python -m PyInstaller app.py `
    --name NuControle `
    --onefile `
    --windowed `
    --noconfirm `
    --icon assets\icone.ico `
    --add-data "frontend;frontend" `
    --add-data "assets\icone.ico;assets"

Write-Host ""
Write-Host "Pronto: dist\NuControle.exe"
