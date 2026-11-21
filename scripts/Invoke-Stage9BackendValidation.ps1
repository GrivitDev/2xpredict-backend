[CmdletBinding()]
param(
    [switch]$FocusedRegressionOnly,
    [string]$ReportDirectory = '.\stage9-reports'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath '.\package.json')) {
    throw 'Run this script from the 2xPredict backend root (the folder containing package.json).'
}

$resolvedReportDirectory = [System.IO.Path]::GetFullPath($ReportDirectory)
New-Item -ItemType Directory -Path $resolvedReportDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$testLog = Join-Path $resolvedReportDirectory "stage9-jest-$stamp.log"
$buildLog = Join-Path $resolvedReportDirectory "stage9-build-$stamp.log"
$summaryPath = Join-Path $resolvedReportDirectory "stage9-validation-$stamp.json"

$focusedTests = @(
    'src/system-monitor/system-monitor-request-context.service.spec.ts',
    'src/system-monitor/system-monitor-performance.service.spec.ts',
    'src/system-monitor/system-monitor-database-tracker.service.spec.ts',
    'src/system-monitor/system-monitor-database-tracker.service.stage7.pool.spec.ts',
    'src/system-monitor/http-compression.spec.ts',
    'src/system-monitor/http-delivery-byte-counter.middleware.spec.ts',
    'src/system-monitor/system-monitor-http-delivery.service.spec.ts',
    'src/prediction-access/prediction-access.service.stage2.performance.spec.ts',
    'src/predictions-engine/services/curated-prediction.service.performance.spec.ts',
    'src/prediction-access/prediction-access.service.performance.spec.ts',
    'src/prediction-access/prediction-access.service.policy.spec.ts',
    'src/sports/services/sports-domain-read.service.stage3.performance.spec.ts',
    'src/sports/services/sports-domain-read.service.batch-read.spec.ts',
    'src/sports/services/sports-domain-read.service.performance.spec.ts',
    'src/analytics/analytics.service.stage4.performance.spec.ts',
    'src/subscriptions/subscriptions.service.stage5.performance.spec.ts',
    'src/subscriptions/subscriptions.controller.performance.spec.ts',
    'src/odds/controllers/odds-center.controller.performance.spec.ts',
    'src/user-session/user-session.service.performance.spec.ts'
)

$npmTestArguments = @('test', '--', '--runInBand')
if ($FocusedRegressionOnly) {
    $missingTests = @($focusedTests | Where-Object { -not (Test-Path -LiteralPath $_) })
    if ($missingTests.Count -gt 0) {
        Write-Host 'Focused Stage 0–8 test files missing from this checkout:' -ForegroundColor Red
        $missingTests | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        Write-Host 'Use the default full Jest run or restore the missing stage test files.' -ForegroundColor Yellow
        exit 2
    }
    $npmTestArguments += $focusedTests
}

Write-Host ''
Write-Host '2xPredict Stage 9 — backend validation' -ForegroundColor Cyan
Write-Host "Backend: $((Get-Location).Path)"
Write-Host "Report directory: $resolvedReportDirectory"
Write-Host "Node: $(& node --version)"
Write-Host "npm:  $(& npm --version)"
if ($FocusedRegressionOnly) {
    Write-Host "Mode: focused Stage 0–8 regression suite ($($focusedTests.Count) specs)"
} else {
    Write-Host 'Mode: full Jest test suite'
}

Write-Host ''
Write-Host 'STEP 1/2 — Jest tests' -ForegroundColor Cyan
& npm @npmTestArguments 2>&1 | Tee-Object -FilePath $testLog
$testExitCode = $LASTEXITCODE

Write-Host ''
Write-Host 'STEP 2/2 — NestJS production build' -ForegroundColor Cyan
& npm run build 2>&1 | Tee-Object -FilePath $buildLog
$buildExitCode = $LASTEXITCODE

$overallStatus = if ($testExitCode -eq 0 -and $buildExitCode -eq 0) { 'PASSED' } else { 'FAILED' }
$summary = [ordered]@{
    project = '2xPredict'
    stage = 9
    generatedAt = (Get-Date).ToString('o')
    workingDirectory = (Get-Location).Path
    mode = if ($FocusedRegressionOnly) { 'focused-regression' } else { 'full-jest' }
    jest = [ordered]@{
        exitCode = $testExitCode
        log = [System.IO.Path]::GetFileName($testLog)
    }
    nestBuild = [ordered]@{
        exitCode = $buildExitCode
        log = [System.IO.Path]::GetFileName($buildLog)
    }
    status = $overallStatus
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

Write-Host ''
Write-Host "Jest exit code: $testExitCode"
Write-Host "Build exit code: $buildExitCode"
Write-Host "Validation status: $overallStatus" -ForegroundColor $(if ($overallStatus -eq 'PASSED') { 'Green' } else { 'Red' })
Write-Host "Summary: $summaryPath"
Write-Host "Jest log: $testLog"
Write-Host "Build log: $buildLog"

if ($overallStatus -ne 'PASSED') {
    exit 1
}

exit 0
