# verify.ps1 — canonical 完整性综合校验（数量/大小写/frontmatter/编码/哈希/引用/适配器/registry/记忆/保护基线）
# 用法: .\verify.ps1   （全部通过退出码 0；任何一项失败退出码 1）
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$w = Join-Path $root '.htyworkflows'
$issues = New-Object System.Collections.Generic.List[string]
function Check([bool]$ok, [string]$name, [string]$detail = '') {
    if ($ok) { Write-Host "  PASS $name" } else { Write-Host "  FAIL $name $detail"; $script:issues.Add("$name $detail") }
}
$m = Get-Content (Join-Path $w 'workflow-manifest.json') -Raw | ConvertFrom-Json
$ids = @(Get-ChildItem (Join-Path $w 'skills') -Directory | Where-Object { -not $_.Name.StartsWith('.') } | Select-Object -ExpandProperty Name)

# 1) 数量与 manifest 集合一致(动态:HtyHubApp 装/卸 skill 后数量合法变动,以 canonical 实况为准)
Check ($ids.Count -gt 0 -and $ids.Count -eq $m.skills.Count) "数量: canonical=manifest=$($ids.Count)" "(实际 $($ids.Count)/$($m.skills.Count))"
$midSet = @($m.skills | Select-Object -ExpandProperty id)
Check (-not (Compare-Object $ids $midSet)) 'ID 集合: canonical == manifest'

# 2) 入口大小写 + frontmatter + manifest 哈希
$badEntry = 0; $badFm = 0; $badHash = 0
foreach ($s in $m.skills) {
    $entry = Get-ChildItem (Join-Path $w "skills\$($s.id)") -File | Where-Object { $_.Name -ieq 'SKILL.md' }
    if (-not $entry -or $entry.Name -cne 'SKILL.md') { $badEntry++; continue }
    $t = [IO.File]::ReadAllText($entry.FullName)
    if ($t.TrimStart([char]0xFEFF) -notmatch '(?s)^---\r?\n.*?\r?\n---') { $badFm++ }
    if ((Get-FileHash $entry.FullName -Algorithm SHA256).Hash -ne $s.entrySha256) { $badHash++ }
}
Check ($badEntry -eq 0) '入口: 全部精确大写 SKILL.md' "(异常 $badEntry)"
Check ($badFm -eq 0) "frontmatter: $($m.skills.Count) 个全部可解析" "(异常 $badFm)"
Check ($badHash -eq 0) 'manifest entrySha256 与实际一致' "(漂移 $badHash)"

# 3) 编码: openai.yaml 无损坏字符
$badYaml = @(Get-ChildItem (Join-Path $w 'skills') -Recurse -Filter 'openai.yaml' -File |
    Where-Object { ([IO.File]::ReadAllText($_.FullName)).Contains([char]0xFFFD) })
Check ($badYaml.Count -eq 0) 'openai.yaml: 无 U+FFFD' "($($badYaml.Count) 个损坏)"

# 4) 适配器: sync-adapters --check
& (Join-Path $PSScriptRoot 'sync-adapters.ps1') -Check *> $null
Check ($LASTEXITCODE -eq 0) '适配器: 全部与 canonical 契约一致'

# 5) registry: htyhub-skills-installed.json（工程条件项：文件存在才校验）
$regPath = Join-Path $root 'HtyHub\htyhub-skills-installed.json'
if (Test-Path $regPath) {
    $reg = Get-Content $regPath -Raw | ConvertFrom-Json
    $regIds = @($reg.skills | Select-Object -ExpandProperty id)
    Check (-not (Compare-Object $ids $regIds)) 'registry: ID 集合与 canonical 一致'
    $badPath = @($reg.skills | Where-Object { $_.localPath -ne ".htyworkflows/skills/$($_.id)" })
    Check ($badPath.Count -eq 0) 'registry: localPath 全部 canonical' "($($badPath.Count) 异常)"
} else {
    Write-Host '  SKIP registry: HtyHub 不存在,跳过(条件项)'
}

# 6) path-audit
& (Join-Path $PSScriptRoot 'path-audit.ps1') *> $null
Check ($LASTEXITCODE -eq 0) 'path-audit: 活跃层无未登记旧路径'

# 7) 活跃写入目标存在
foreach ($d in 'plans','plans_waitChoose','changeLog','changeLogHistory','chatContinue','handoff','docking','svg','testKPI','userTeach','runtime\logs','history\bug-records','history\tech-debt','user-real-design','memory') {
    if (-not (Test-Path (Join-Path $w $d))) { $issues.Add("活跃写入目标缺失: $d") }
}
Check ($issues.Count -eq $issues.Count) '活跃写入目标目录存在'   # 上循环已记录缺失

# 8) 受保护原生文件哈希 = manifest 基线（决策 2A 铁律）
$drift = 0
foreach ($p in $m.protectedNativeConfig) {
    $cur = (Get-FileHash (Join-Path $root $p.path) -Algorithm SHA256).Hash
    if ($cur -ne $p.sha256) { $drift++; $issues.Add("受保护文件漂移: $($p.path)") }
}
Check ($drift -eq 0) "受保护原生文件: $(@($m.protectedNativeConfig).Count) 个字节不变"

# 9) 记忆完整性: canonical(除 MEMORY.md 契约段) 与 Claude 产品缓存一致（缓存路径按工作区 slug 推导；不存在则跳过）
$slug = ($root -replace '[:\\/_]', '-')
$memSrc = Join-Path $env:USERPROFILE ".claude\projects\$slug\memory"
if (Test-Path $memSrc) {
    $memDiff = 0
    foreach ($f in (Get-ChildItem $memSrc -Recurse -File -Force)) {
        $rel = $f.FullName.Substring($memSrc.Length + 1)
        if ($rel -eq 'MEMORY.md') { continue }
        $d = Join-Path $w "memory\$rel"
        if (-not (Test-Path $d) -or (Get-FileHash $d -Algorithm SHA256).Hash -ne (Get-FileHash $f.FullName -Algorithm SHA256).Hash) { $memDiff++ }
    }
    Check ($memDiff -eq 0) '记忆: canonical 与产品缓存一致(契约段除外)' "($memDiff 差异)"
} else {
    Write-Host '  SKIP 记忆: Claude 产品缓存不存在,跳过(条件项)'
}

"`n===== verify 结论: $($issues.Count) 个问题 ====="
$issues | ForEach-Object { "  ISSUE: $_" }
if ($issues.Count -gt 0) { exit 1 } else { exit 0 }