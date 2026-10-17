# validate_real_experiment.ps1
# Validates a results directory against the canary or full-matrix gate.
# Honors VRC_RESULTS_ROOT and adapts checks based on each run's CAPTURE_MODE
# (visual gates skipped when status.json says metrics_only).
param(
    [string]$Methods   = "Full,Spark-MU,VP-S,NET-S,VRC-V,VRC-N,VRC-O,VRC",
    [string]$Scenarios = "nearby,burst_turn,divergent",
    [int]   $Trials    = 3
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ResultsRoot = if ($env:VRC_RESULTS_ROOT) { $env:VRC_RESULTS_ROOT } else { Join-Path $ScriptDir "results" }
$rawDir = Join-Path $ResultsRoot "raw"
$ssDir  = Join-Path $ResultsRoot "screenshots"
$report = Join-Path $ResultsRoot "VALIDATION_REPORT.md"

$rows = @()
$pass = 0; $fail = 0; $missing = 0
$expectedTotal = 0

foreach ($m in $Methods -split ",") {
    foreach ($s in $Scenarios -split ",") {
        for ($t=0; $t -lt $Trials; $t++) {
            $expectedTotal++
            $patt = "${m}_${s}_t${t}_*"
            $dir = Get-ChildItem $rawDir -Directory -Filter $patt -ErrorAction SilentlyContinue | Select-Object -First 1
            $issues = @()
            $isMetricsOnly = $false
            if (-not $dir) {
                $issues += "MISSING_RUN_DIR"
                $missing++
            } else {
                foreach ($f in @("config.json","status.json","client_logs.jsonl","client_metrics.jsonl","request_logs.jsonl")) {
                    if (-not (Test-Path (Join-Path $dir.FullName $f))) { $issues += "MISSING_$f" }
                }
                if ($dir.Name -match "_sim") { $issues += "SIM_SESSION_ID" }

                # Detect metrics_only mode from status.json visual_check or capture_records.
                $statusFile = Join-Path $dir.FullName "status.json"
                $statusObj = $null
                if (Test-Path $statusFile) {
                    try { $statusObj = Get-Content $statusFile -Raw | ConvertFrom-Json } catch {}
                }
                if ($statusObj -and $statusObj.capture_records) {
                    $strategies = $statusObj.capture_records | ForEach-Object { $_.strategy }
                    if ($strategies -contains "metrics_only") { $isMetricsOnly = $true }
                }
                if ($statusObj -and $statusObj.status -ne "PASS") { $issues += "STATUS_$($statusObj.status)" }

                $reqFile = Join-Path $dir.FullName "request_logs.jsonl"
                if (Test-Path $reqFile) {
                    $reqLines = (Get-Content $reqFile).Count
                    if ($reqLines -lt 1) { $issues += "NO_REQUESTS" }
                    $chunkLines = (Select-String -Path $reqFile -Pattern '\.rad|\.spz|\.splat|forge-dev-public|\.r2\.dev' -ErrorAction SilentlyContinue).Count
                    if ($chunkLines -lt 1) { $issues += "NO_CHUNK_REQUESTS" }
                }

                # Visual checks only apply when not in metrics_only mode.
                if (-not $isMetricsOnly) {
                    $shots = Get-ChildItem $ssDir -Filter "$($dir.Name)_u*.png" -ErrorAction SilentlyContinue
                    if ($shots.Count -lt 4) { $issues += "SCREENSHOTS_$($shots.Count)of4" }
                    foreach ($sh in $shots) { if ($sh.Length -lt 8000) { $issues += "SS_TOOSMALL_$($sh.Name)" } }
                    $vc = Join-Path $dir.FullName "visual_check.json"
                    if (Test-Path $vc) {
                        try {
                            $vj = Get-Content $vc -Raw | ConvertFrom-Json
                            $strict = ($env:VRC_VALIDATE_STRICT -eq "1")
                            if (-not $vj.summary.all_valid) {
                                $reasons = ($vj.summary.failures -join "|")
                                if ($strict) {
                                    $issues += "VISUAL_FAIL:$reasons"
                                } else {
                                    $validCount = [int]$vj.summary.users_valid
                                    if ($validCount -lt 3) {
                                        $issues += "VISUAL_FAIL:$reasons"
                                    }
                                }
                            }
                        } catch { $issues += "VISUAL_CHECK_PARSE_ERROR" }
                    } else { $issues += "NO_VISUAL_CHECK" }
                    # Full-method visual runs: require all four users to have real asset signal + screenshot (canary1b gate).
                    if ($m -eq "Full" -and -not $isMetricsOnly) {
                        $stFile = Join-Path $dir.FullName "screenshot_timing.jsonl"
                        if (-not (Test-Path $stFile)) {
                            $issues += "NO_SCREENSHOT_TIMING"
                        } else {
                            $need = @("u0","u1","u2","u3")
                            $got = @{}
                            Get-Content $stFile | ForEach-Object {
                                try {
                                    $tj = $_ | ConvertFrom-Json
                                    if ($need -contains $tj.user_id) { $got[$tj.user_id] = $tj }
                                } catch {}
                            }
                            foreach ($uid in $need) {
                                if (-not $got.ContainsKey($uid)) { $issues += "QUORUM_NO_ROW_$uid"; continue }
                                $tr = $got[$uid]
                                if (-not $tr.screenshot_saved) { $issues += "QUORUM_NO_SCREENSHOT_$uid" }
                                $ch = 0; try { $ch = [int]$tr.chunks_at_ready } catch {}
                                if ($ch -le 0) { $issues += "QUORUM_CHUNKS_$uid" }
                                $ao = 0; try { $ao = [int]$tr.asset_ok_at_ready } catch {}
                                if ($ao -le 0) { $issues += "QUORUM_ASSET_OK_$uid" }
                                $lu = $null
                                try { $lu = [double]$tr.luma_std_at_ready } catch {}
                                if ($null -eq $lu -or $lu -le 0) { $issues += "QUORUM_LUMA_STD_$uid" }
                            }
                        }
                    }
                    if ($env:VRC_VALIDATE_STRICT -eq "1" -and $statusObj -and $statusObj.capture_records) {
                        foreach ($cr in $statusObj.capture_records) {
                            $fr = "$($cr.failure_reason)$($cr.visual_ready_reason)"
                            if ($fr -match "CAPTURE_TIMEOUT|FILE_MISSING|FLAT_COLOR|LOAD_INCOMPLETE") {
                                $issues += "STRICT_CAPTURE_RECORD:$fr"
                            }
                        }
                    }
                }

                if ($m -match "^VRC") {
                    if (-not (Test-Path (Join-Path $dir.FullName "vrc_decisions.jsonl"))) { $issues += "NO_VRC_DECISIONS" }
                }

                $cm = Join-Path $dir.FullName "client_metrics.jsonl"
                if (Test-Path $cm) {
                    $hasNonZeroP95 = $false
                    Get-Content $cm | ForEach-Object {
                        try {
                            $j = $_ | ConvertFrom-Json
                            $p95src = $j.object_or_range_completion_p95_ms
                            if ($p95src -and [double]$p95src -gt 0) { $hasNonZeroP95 = $true }
                            elseif ($j.p95_latency_ms -and [double]$j.p95_latency_ms -gt 0) { $hasNonZeroP95 = $true }
                        } catch {}
                    }
                    if (-not $hasNonZeroP95) { $issues += "P95_ZERO_OR_MISSING" }
                }
            }

            $verdict = if ($issues.Count -eq 0) { $pass++; "PASS" } else { $fail++; "FAIL" }
            $rows += [PSCustomObject]@{ Method=$m; Scenario=$s; Trial=$t; Verdict=$verdict; Issues=($issues -join ";") }
        }
    }
}

$total = $rows.Count
$lines = @("# VALIDATION_REPORT","","Total: $total  PASS: $pass  FAIL: $fail  MISSING: $missing","")
$lines += "| Method | Scenario | Trial | Verdict | Issues |"
$lines += "|--------|----------|-------|---------|--------|"
foreach ($r in $rows) { $lines += "| $($r.Method) | $($r.Scenario) | $($r.Trial) | $($r.Verdict) | $($r.Issues) |" }
Set-Content $report ($lines -join "`n")
Write-Host "Wrote $report  ($pass PASS / $fail FAIL / $total total expected=$expectedTotal)"

# Validator passes when all enumerated runs pass; size check (72) is enforced by the caller.
if ($fail -gt 0 -or $total -lt $expectedTotal) { exit 1 } else { exit 0 }
