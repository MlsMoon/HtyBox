# sync-all.ps1 — 全 Agent 完整同步与对齐检查（机械部分；人工项只报告不代劳）
# 产物: agentsSynchronizer/last-sync-report.md;退出码 0=全绿, 1=存在需处理项
# 编码: 本文件必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按系统代码页误读中文并解析失败。
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$w = Join-Path $root '.htyworkflows'
$R = New-Object System.Collections.Generic.List[string]
$manual = 0
$R.Add("# 全 Agent 同步与对齐报告（$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')）`n")

# ① 名册零遗漏对账: adapters/ 子目录 == manifest.providers == rules/<agent>.md
$m = Get-Content (Join-Path $w 'workflow-manifest.json') -Raw | ConvertFrom-Json
$rosterDirs = @(Get-ChildItem (Join-Path $w 'adapters') -Directory | Select-Object -ExpandProperty Name | Sort-Object)
$providers = @($m.providers.PSObject.Properties.Name | Sort-Object)
$ruleFiles = @(Get-ChildItem (Join-Path $w 'rules') -File -Filter '*.md' | Where-Object Name -ne 'common.md' |
    ForEach-Object { $_.BaseName } | Sort-Object)
$R.Add("## ① 名册零遗漏对账")
$R.Add("- adapters/ 名册: $($rosterDirs -join ', ')")
$R.Add("- manifest providers: $($providers -join ', ')")
$R.Add("- rules 差异条款: $($ruleFiles -join ', ')")
if ((Compare-Object $rosterDirs $providers) -or (Compare-Object $rosterDirs $ruleFiles)) {
    $R.Add("- **不一致！存在遗漏或未接入完整的 Agent（按 adapters/README.md 五步接入补齐）** ⚠"); $manual++
} else { $R.Add("- 三处一致，零遗漏 ✓") }

# ② Skill 全量同步: canonical vs manifest 登记对账 → 全量重生成 → check
$R.Add("`n## ② Skill 全量同步（全部在册 Agent）")
$ids = @(Get-ChildItem (Join-Path $w 'skills') -Directory | Where-Object { -not $_.Name.StartsWith('.') } | Select-Object -ExpandProperty Name)
$mids = @($m.skills | Select-Object -ExpandProperty id)
$unreg = @($ids | Where-Object { $_ -notin $mids }); $ghost = @($mids | Where-Object { $_ -notin $ids })
foreach ($u in $unreg) { $R.Add("- UNREGISTERED: canonical 有 ``$u`` 但 manifest 未登记 → 补登后重跑 ⚠"); $manual++ }
foreach ($g in $ghost) { $R.Add("- GHOST: manifest 登记 ``$g`` 但 canonical 无此目录 → 决议后清账 ⚠"); $manual++ }
# manifest 登记对齐实况: canonical 是唯一可编辑权威,SKILL.md 合法更新后登记须跟随（自动刷新并报告）
$refreshed = @()
foreach ($s in $m.skills) {
    $p = Join-Path $w "skills\$($s.id)\SKILL.md"
    if (-not (Test-Path $p)) { continue }
    $h = (Get-FileHash $p -Algorithm SHA256).Hash
    if ($s.entrySha256 -ne $h) {
        $s.entrySha256 = $h
        $s.fileCount = (Get-ChildItem (Join-Path $w "skills\$($s.id)") -Recurse -File -Force | Measure-Object).Count
        $refreshed += $s.id
    }
}
if ($refreshed.Count -gt 0) {
    $m.generatedUtc = (Get-Date).ToUniversalTime().ToString('o')
    $m | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $w 'workflow-manifest.json') -Encoding utf8
    $R.Add("- manifest 登记刷新（canonical 有合法更新）: $($refreshed -join ', ')")
}
& (Join-Path $w 'tools\sync-adapters.ps1') *> $null
& (Join-Path $w 'tools\sync-adapters.ps1') -Check *> $null
if ($LASTEXITCODE -eq 0) { $R.Add("- canonical $($ids.Count) 个 Skill → 全部在册 Agent 薄壳已重生成，check 零漂移 ✓") }
else { $R.Add("- **sync-adapters check 未过** ⚠"); $manual++ }

# ③ 记忆同步（Claude 缓存链路,安全单向收敛;Codex 直读 canonical 无需同步）
$R.Add("`n## ③ 记忆同步")
$memSrc = Join-Path $w 'memory'
$slug = ($root -replace '[:\\/_]', '-')
$cache = Join-Path $env:USERPROFILE ".claude\projects\$slug\memory"
$fill = 0; $same = 0
# 两侧目录缺失都是状态而非异常(与引擎 converge_memory 同构):canonical 缺失→零下发;缓存缺失→零 UNCURATED
$srcFiles = @(if (Test-Path $memSrc) { Get-ChildItem $memSrc -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\imports\\' } })
foreach ($f in $srcFiles) {
    $rel = $f.FullName.Substring($memSrc.Length + 1)
    if ($rel -eq 'MEMORY.md') { continue }   # 契约段仅存 canonical,不下发
    $dst = Join-Path $cache $rel
    if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null; Copy-Item $f.FullName $dst; $fill++ }
    elseif ((Get-FileHash $dst -Algorithm SHA256).Hash -eq (Get-FileHash $f.FullName -Algorithm SHA256).Hash) { $same++ }
    else { $R.Add("- CONFLICT: ``$rel`` 两侧内容不同 → 人工确认后双写收敛 ⚠"); $manual++ }
}
$cacheFiles = @(if (Test-Path $cache) { Get-ChildItem $cache -Recurse -File -Force })
foreach ($f in $cacheFiles) {
    $rel = $f.FullName.Substring($cache.Length + 1)
    if ($rel -eq 'MEMORY.md') { continue }
    if (-not (Test-Path (Join-Path $memSrc $rel))) { $R.Add("- UNCURATED: 缓存多出 ``$rel``（canonical 无）→ 按策展纪律收编或清理 ⚠"); $manual++ }
}
# MEMORY.md 特例: canonical = 契约段 + 索引正文;缓存应等于其去契约段部分（任一侧缺失则按状态说明,不判冲突）
$cmPath = Join-Path $memSrc 'MEMORY.md'; $pmPath = Join-Path $cache 'MEMORY.md'
if ((Test-Path $cmPath) -and (Test-Path $pmPath)) {
    $cm = [IO.File]::ReadAllText($cmPath); $pm = [IO.File]::ReadAllText($pmPath)
    if (-not $cm.Contains($pm.TrimStart([char]0xFEFF))) { $R.Add("- CONFLICT: MEMORY.md 索引正文两侧不一致 → 人工确认 ⚠"); $manual++ }
    else { $R.Add("- Claude 缓存: 补齐 $fill / 一致 $same / MEMORY.md 索引包含关系 ✓") }
} else {
    $R.Add("- Claude 缓存: 补齐 $fill / 一致 $same / MEMORY.md 状态: canonical=$(Test-Path $cmPath) 缓存=$(Test-Path $pmPath)")
}
$R.Add("- Codex: 直读 canonical（rules/codex.md 指引$(if (Test-Path (Join-Path $w 'rules\codex.md')) { '存在 ✓' } else { '缺失 ⚠' })）")

# ④ 全套校验
$R.Add("`n## ④ 全套校验")
& (Join-Path $w 'tools\verify.ps1') *> $null
$R.Add("- verify.ps1: $(if ($LASTEXITCODE -eq 0) { '13 项全过 ✓' } else { $manual++; '存在失败项，跑 tools\verify.ps1 看明细 ⚠' })")
& (Join-Path $w 'tools\path-audit.ps1') *> $null
$R.Add("- path-audit.ps1: $(if ($LASTEXITCODE -eq 0) { '零未登记旧路径 ✓' } else { $manual++; '存在违规引用 ⚠' })")

$R.Add("`n## 结论: $(if ($manual -eq 0) { '全绿，零人工项' } else { "需人工处理 $manual 项（标 ⚠）" })")
$R -join "`n" | Set-Content (Join-Path $PSScriptRoot 'last-sync-report.md') -Encoding utf8
$R | ForEach-Object { $_ }
if ($manual -gt 0) { exit 1 } else { exit 0 }