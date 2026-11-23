# Builds the game and deploys it to the EC2 (served by nginx on port 8090).
# Usage (from the project root):  .\deploy.ps1   or   npm run deploy

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot   # always run from the project root, wherever it was called from

# Stops the script if the last command failed
function Assert-Ok($step) {
    if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $step" -ForegroundColor Red; exit 1 }
}

Write-Host "1/4 Building..."
npm run build;                                  Assert-Ok "build"

Write-Host "2/4 Packing..."
tar -czf find-me-dist.tgz -C dist .;            Assert-Ok "tar"

Write-Host "3/4 Uploading..."
scp find-me-dist.tgz my-ec2:/tmp/;              Assert-Ok "upload"
Remove-Item find-me-dist.tgz

Write-Host "4/4 Installing on server..."
ssh my-ec2 "sudo rm -rf /var/www/find-me/* && sudo tar -xzf /tmp/find-me-dist.tgz -C /var/www/find-me && rm /tmp/find-me-dist.tgz"
Assert-Ok "install"

Write-Host "Deployed: http://54.76.118.84:8090/" -ForegroundColor Green
