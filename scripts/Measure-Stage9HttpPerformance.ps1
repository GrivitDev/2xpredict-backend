[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [string[]]$Paths = @(
        '/api/admin/system-monitor/performance/requests?limit=50',
        '/api/admin/system-monitor/performance/database?limit=50',
        '/api/admin/system-monitor/database/pool',
        '/api/admin/system-monitor/performance/http-delivery?limit=50'
    ),

    [ValidateRange(3, 50)]
    [int]$Iterations = 10,

    [ValidateRange(0, 5)]
    [int]$WarmupRequests = 1,

    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 30,

    [switch]$UseAdminAuth,

    [switch]$CaptureAdminTelemetry,

    [string]$ReportDirectory = '.\stage9-reports'
)

$ErrorActionPreference = 'Stop'

try {
    $baseUri = [System.Uri]::new($BaseUrl, [System.UriKind]::Absolute)
} catch {
    throw "BaseUrl must be an absolute URL, for example https://api.example.com or http://localhost:5000."
}

if ($baseUri.Scheme -notin @('http', 'https')) {
    throw 'BaseUrl must use HTTP or HTTPS.'
}
if ($Paths.Count -lt 1) {
    throw 'Provide at least one GET path to measure.'
}
if ($Paths.Count -gt 20) {
    throw 'For safety, measure no more than 20 paths per run.'
}
if ($CaptureAdminTelemetry -and -not $UseAdminAuth) {
    throw 'CaptureAdminTelemetry requires UseAdminAuth.'
}

$tokenText = $null
if ($UseAdminAuth) {
    $secureToken = Read-Host 'Enter the admin JWT (input is hidden)' -AsSecureString
    $tokenPointer = [IntPtr]::Zero
    try {
        $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        $tokenText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    } finally {
        if ($tokenPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
        }
        if ($null -ne $secureToken) {
            $secureToken.Dispose()
        }
    }
    if ([string]::IsNullOrWhiteSpace($tokenText)) {
        throw 'An admin JWT is required when UseAdminAuth is selected.'
    }
}

$resolvedReportDirectory = [System.IO.Path]::GetFullPath($ReportDirectory)
New-Item -ItemType Directory -Path $resolvedReportDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$rawCsvPath = Join-Path $resolvedReportDirectory "stage9-http-samples-$stamp.csv"
$summaryCsvPath = Join-Path $resolvedReportDirectory "stage9-http-summary-$stamp.csv"
$summaryJsonPath = Join-Path $resolvedReportDirectory "stage9-http-summary-$stamp.json"
$telemetryJsonPath = Join-Path $resolvedReportDirectory "stage9-admin-telemetry-$stamp.json"

# Do not enable automatic decompression: body byte counts must retain the
# Content-Encoding representation returned by the server.
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.AutomaticDecompression = [System.Net.DecompressionMethods]::None
$handler.UseCookies = $false
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
$script:stage9Client = $client
$script:stage9Token = $tokenText
$script:stage9Samples = [System.Collections.Generic.List[object]]::new()

function Invoke-Stage9HttpGet {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateSet('identity', 'gzip', 'br')][string]$Encoding,
        [switch]$Warmup
    )

    if ($Path -notmatch '^/') {
        throw "Each path must begin with '/': $Path"
    }

    $requestUri = [System.Uri]::new($script:stage9BaseUri, $Path)
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $requestUri)
    $request.Headers.Accept.ParseAdd('application/json, */*')

    $acceptEncoding = switch ($Encoding) {
        'identity' { 'identity' }
        'gzip' { 'gzip' }
        'br' { 'br' }
    }
    $null = $request.Headers.TryAddWithoutValidation('Accept-Encoding', $acceptEncoding)

    if (-not [string]::IsNullOrWhiteSpace($script:stage9Token)) {
        $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $script:stage9Token)
    }

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $response = $null
    $statusCode = 0
    $bodyBytes = 0
    $actualEncoding = 'identity'
    $errorType = $null

    try {
        $response = $script:stage9Client.SendAsync(
            $request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        $statusCode = [int]$response.StatusCode
        $body = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        $bodyBytes = [long]$body.LongLength
        $encodings = @($response.Content.Headers.ContentEncoding)
        if ($encodings.Count -gt 0) {
            $actualEncoding = ($encodings -join ',').ToLowerInvariant()
        }
    } catch {
        $errorType = $_.Exception.GetType().Name
    } finally {
        $timer.Stop()
        if ($null -ne $response) {
            $response.Dispose()
        }
        $request.Dispose()
    }

    if (-not $Warmup) {
        $script:stage9Samples.Add([pscustomobject]@{
            Timestamp = (Get-Date).ToString('o')
            Path = $Path
            RequestedEncoding = $Encoding
            ActualEncoding = $actualEncoding
            StatusCode = $statusCode
            DurationMs = [Math]::Round($timer.Elapsed.TotalMilliseconds, 2)
            BodyBytes = $bodyBytes
            ErrorType = $errorType
        })
    }
}

function Get-Stage9Percentile {
    param([double[]]$Values, [double]$Percentile)
    if ($null -eq $Values -or $Values.Count -eq 0) { return 0 }
    $ordered = @($Values | Sort-Object)
    $index = [int][Math]::Ceiling($Percentile * $ordered.Count) - 1
    if ($index -lt 0) { $index = 0 }
    if ($index -ge $ordered.Count) { $index = $ordered.Count - 1 }
    return [Math]::Round([double]$ordered[$index], 2)
}

$script:stage9BaseUri = $baseUri
$encodingsToTest = @('identity', 'gzip', 'br')

try {
    Write-Host ''
    Write-Host '2xPredict Stage 9 — sequential HTTP performance measurement' -ForegroundColor Cyan
    Write-Host "Base URL: $($baseUri.GetLeftPart([System.UriPartial]::Authority))"
    Write-Host "Paths: $($Paths.Count) | Iterations per encoding: $Iterations | Warmups: $WarmupRequests"
    Write-Host 'Concurrency: 1 (sequential, read-only GET requests)'
    if ($UseAdminAuth) { Write-Host 'Admin authentication: supplied through hidden prompt' }

    foreach ($path in $Paths) {
        foreach ($encoding in $encodingsToTest) {
            for ($warmup = 0; $warmup -lt $WarmupRequests; $warmup++) {
                Invoke-Stage9HttpGet -Path $path -Encoding $encoding -Warmup
            }
            for ($iteration = 0; $iteration -lt $Iterations; $iteration++) {
                Invoke-Stage9HttpGet -Path $path -Encoding $encoding
            }
            Write-Host "Completed: $encoding $path"
        }
    }

    $script:stage9Samples | Export-Csv -LiteralPath $rawCsvPath -NoTypeInformation -Encoding UTF8

    $summaryRows = [System.Collections.Generic.List[object]]::new()
    $groups = @($script:stage9Samples | Group-Object -Property Path, RequestedEncoding)
    foreach ($group in $groups) {
        $items = @($group.Group)
        $successful = @($items | Where-Object { $_.StatusCode -ge 200 -and $_.StatusCode -lt 300 })
        $durations = [double[]]@($successful | ForEach-Object { [double]$_.DurationMs })
        $sizes = [double[]]@($successful | ForEach-Object { [double]$_.BodyBytes })
        $actualEncodings = @($successful | Group-Object -Property ActualEncoding | ForEach-Object { "$($_.Name):$($_.Count)" }) -join ';'
        $failureCount = @($items | Where-Object { $_.StatusCode -lt 200 -or $_.StatusCode -ge 300 }).Count
        $averageDuration = if ($durations.Count -gt 0) { [Math]::Round((($durations | Measure-Object -Average).Average), 2) } else { 0 }
        $averageBytes = if ($sizes.Count -gt 0) { [Math]::Round((($sizes | Measure-Object -Average).Average), 0) } else { 0 }

        $summaryRows.Add([pscustomobject]@{
            Path = $items[0].Path
            RequestedEncoding = $items[0].RequestedEncoding
            SuccessfulResponses = $successful.Count
            Non2xxOrTransportFailures = $failureCount
            AverageDurationMs = $averageDuration
            P50DurationMs = Get-Stage9Percentile -Values $durations -Percentile 0.50
            P95DurationMs = Get-Stage9Percentile -Values $durations -Percentile 0.95
            P99DurationMs = Get-Stage9Percentile -Values $durations -Percentile 0.99
            AverageBodyBytes = $averageBytes
            P95BodyBytes = Get-Stage9Percentile -Values $sizes -Percentile 0.95
            ActualEncodings = $actualEncodings
        })
    }

    $identityBytesByPath = @{}
    foreach ($row in $summaryRows) {
        if ($row.RequestedEncoding -eq 'identity' -and $row.SuccessfulResponses -gt 0) {
            $identityBytesByPath[$row.Path] = [double]$row.AverageBodyBytes
        }
    }
    foreach ($row in $summaryRows) {
        $savings = $null
        if ($row.RequestedEncoding -ne 'identity' -and
            $row.SuccessfulResponses -gt 0 -and
            $identityBytesByPath.ContainsKey($row.Path) -and
            $identityBytesByPath[$row.Path] -gt 0) {
            $savings = [Math]::Round((1 - ($row.AverageBodyBytes / $identityBytesByPath[$row.Path])) * 100, 2)
        }
        $row | Add-Member -NotePropertyName CompressionSavingsPercent -NotePropertyValue $savings -Force
    }

    $summaryRows | Sort-Object Path, RequestedEncoding | Export-Csv -LiteralPath $summaryCsvPath -NoTypeInformation -Encoding UTF8
    $summaryRows | Sort-Object Path, RequestedEncoding | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryJsonPath -Encoding UTF8

    Write-Host ''
    Write-Host 'HTTP summary (client elapsed time includes network transfer):' -ForegroundColor Cyan
    $summaryRows | Sort-Object Path, RequestedEncoding | Format-Table Path, RequestedEncoding, SuccessfulResponses, Non2xxOrTransportFailures, P50DurationMs, P95DurationMs, AverageBodyBytes, ActualEncodings, CompressionSavingsPercent -AutoSize -Wrap
    Write-Host "Raw samples: $rawCsvPath"
    Write-Host "Summary CSV: $summaryCsvPath"
    Write-Host "Summary JSON: $summaryJsonPath"

    if ($CaptureAdminTelemetry) {
        $telemetryPaths = @(
            '/api/admin/system-monitor/performance/requests?limit=50',
            '/api/admin/system-monitor/performance/database?limit=50',
            '/api/admin/system-monitor/database/pool',
            '/api/admin/system-monitor/performance/http-delivery?limit=50'
        )
        $telemetry = [ordered]@{
            generatedAt = (Get-Date).ToString('o')
            baseUrl = $baseUri.GetLeftPart([System.UriPartial]::Authority)
            endpoints = @()
        }

        foreach ($telemetryPath in $telemetryPaths) {
            $telemetryUri = [System.Uri]::new($baseUri, $telemetryPath)
            $telemetryRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $telemetryUri)
            $telemetryRequest.Headers.Accept.ParseAdd('application/json')
            $telemetryRequest.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $script:stage9Token)
            $telemetryResponse = $null
            try {
                $telemetryResponse = $script:stage9Client.SendAsync($telemetryRequest).GetAwaiter().GetResult()
                $telemetryBody = $telemetryResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                $parsedBody = $null
                try {
                    $parsedBody = $telemetryBody | ConvertFrom-Json -ErrorAction Stop
                } catch {
                    $parsedBody = @{ parseError = 'Response was not valid JSON.' }
                }
                $telemetry.endpoints += [pscustomobject]@{
                    path = $telemetryPath
                    statusCode = [int]$telemetryResponse.StatusCode
                    data = $parsedBody
                }
            } catch {
                $telemetry.endpoints += [pscustomobject]@{
                    path = $telemetryPath
                    statusCode = 0
                    errorType = $_.Exception.GetType().Name
                }
            } finally {
                if ($null -ne $telemetryResponse) { $telemetryResponse.Dispose() }
                $telemetryRequest.Dispose()
            }
        }

        $telemetry | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath $telemetryJsonPath -Encoding UTF8
        Write-Host "Admin telemetry JSON: $telemetryJsonPath"
    }

    $non2xx = @($script:stage9Samples | Where-Object { $_.StatusCode -lt 200 -or $_.StatusCode -ge 300 })
    if ($non2xx.Count -gt 0) {
        Write-Warning "$($non2xx.Count) benchmark samples were not 2xx. Check authentication, route paths and backend availability before interpreting timings."
    }
} finally {
    $script:stage9Token = $null
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $handler) { $handler.Dispose() }
}
