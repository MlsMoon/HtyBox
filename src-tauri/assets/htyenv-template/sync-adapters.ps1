# sync-adapters.ps1 — 从 canonical 确定性生成两端薄适配器（.claude/skills、.agents/skills）
# 格式契约 v1：与 HtyHubApp skillsService.buildAdapterContent / HtyBox htyenv::adapters 字节一致——
#   适配器 = canonical SKILL.md 的 frontmatter 原字节块(含可选 BOM 与结尾换行) + "\n" + LF 模板
# 用法:
#   .\sync-adapters.ps1            全量生成/刷新两端适配器
#   .\sync-adapters.ps1 -Check     只校验不写入（缺失/手改/陈旧 → 退出码 1）
#   .\sync-adapters.ps1 -SkillId x 只处理单个 skill
# 边界: 只写 <adapterRoot>/<id>/SKILL.md；不触碰 CLAUDE.md/AGENTS.md/settings/config；
#       决策 6 改名的旧目录(.claude/skills/skill-creator 等旧正文)不在本工具管辖，留 Step 12 清理。
# NTFS 注意: Windows 大小写不敏感，对已存在的 skill.md 直接 WriteAllBytes(SKILL.md)
#           只会覆盖内容、不会改正文件名大小写；写入前必须先删除任意大小写变体。
param([switch]$Check, [string]$SkillId)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent   # 工程根
$canonicalRoot = Join-Path $root '.htyworkflows\skills'
$adapterRoots = @((Join-Path $root '.claude\skills'), (Join-Path $root '.agents\skills'))
$MARK = 'AUTO-GENERATED ADAPTER (hty-sync-adapters v1)'

# 提取 frontmatter 原字节块（与 TS sliceFrontmatterBytes 同规则）
function Get-FrontmatterBytes([byte[]]$raw) {
    $text = [Text.Encoding]::UTF8.GetString($raw)
    $m = [regex]::Match($text, "(?s)^﻿?---\r?\n.*?\r?\n---(\r?\n|$)")
    if (-not $m.Success) { return $null }
    return [Text.Encoding]::UTF8.GetBytes($m.Value)
}

# 按契约 v1 构造适配器完整字节（与 TS buildAdapterContent 逐字节一致）
function Build-AdapterBytes([string]$skillId, [byte[]]$canonicalRaw) {
    $fm = Get-FrontmatterBytes $canonicalRaw
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = ([BitConverter]::ToString($sha.ComputeHash($canonicalRaw)) -replace '-', '').ToUpperInvariant()
    $template = @(
        "<!-- $MARK - DO NOT EDIT -->",
        "<!-- canonical: .htyworkflows/skills/$skillId/SKILL.md -->",
        "<!-- entrySha256: $hash -->",
        '',
        '本文件是自动生成的薄适配器,正文唯一权威源位于 canonical 目录:',
        '',
        ('**请读取并完整遵循 `.htyworkflows/skills/' + $skillId + '/SKILL.md`**' +
         '(其 references/、scripts/、assets/ 等相对资源一律以该 canonical 目录为基准解析;' +
         '本适配器目录不存放业务内容,禁止手改——修改请编辑 canonical 后运行 .htyworkflows/tools/sync-adapters.ps1)。'),
        ''
    ) -join "`n"
    $tplBytes = [Text.Encoding]::UTF8.GetBytes("`n" + $template)
    if ($null -ne $fm) { return $fm + $tplBytes }
    return [Text.Encoding]::UTF8.GetBytes($template)
}

# 取目录内 skill 入口文件的真实大小写名；无则返回 $null
function Get-SkillEntryExactName([string]$dir) {
    if (-not (Test-Path -LiteralPath $dir)) { return $null }
    $di = [IO.DirectoryInfo]::new($dir)
    $f = $di.GetFiles() | Where-Object { $_.Name -match '^(?i)skill\.md$' } | Select-Object -First 1
    if ($null -eq $f) { return $null }
    return $f.Name
}

# 写入适配器入口：先删任意大小写变体，再以精确 SKILL.md 落盘（规避 NTFS 保旧名）
function Write-AdapterSkillMd([string]$dst, [byte[]]$bytes) {
    $dir = Split-Path $dst -Parent
    New-Item -ItemType Directory -Force $dir | Out-Null
    $di = [IO.DirectoryInfo]::new($dir)
    foreach ($f in @($di.GetFiles() | Where-Object { $_.Name -match '^(?i)skill\.md$' })) {
        $f.Delete()
    }
    [IO.File]::WriteAllBytes((Join-Path $dir 'SKILL.md'), $bytes)
}

$ids = if ($SkillId) { @($SkillId) } else {
    @(Get-ChildItem $canonicalRoot -Directory | Where-Object { -not $_.Name.StartsWith('.') } | Select-Object -ExpandProperty Name | Sort-Object)
}
# 上下架元数据(与引擎同构): manifest skills[].enabled=false 的 skill 预期无薄壳——生成时清除、check 时残留报问题
$disabled = @{}
$manifestPath = Join-Path $root '.htyworkflows\workflow-manifest.json'
if (Test-Path $manifestPath) {
    foreach ($s in ((Get-Content $manifestPath -Raw | ConvertFrom-Json).skills)) {
        if ($s.PSObject.Properties['enabled'] -and $s.enabled -eq $false) { $disabled[$s.id] = $true }
    }
}
$written = 0; $removed = 0; $ok = 0; $issues = New-Object System.Collections.Generic.List[string]
foreach ($id in $ids) {
    $canonicalMd = Join-Path $canonicalRoot "$id\SKILL.md"
    if (-not (Test-Path $canonicalMd)) { $issues.Add("canonical 缺失: $id"); continue }
    if ($disabled.ContainsKey($id)) {
        foreach ($ar in $adapterRoots) {
            $dDir = Join-Path $ar $id
            if ($Check) {
                if (Test-Path $dDir) { $issues.Add("下架 skill 残留薄壳: $dDir") } else { $ok++ }
            } elseif (Test-Path $dDir) { Remove-Item -Recurse -Force $dDir; $removed++ }
        }
        continue
    }
    $raw = [IO.File]::ReadAllBytes($canonicalMd)
    $expect = Build-AdapterBytes $id $raw
    # Codex 发现层 metadata: canonical 的 agents/ 子目录按字节同步到 .agents 侧薄壳（Claude 侧不需要）
    $metaSrc = Join-Path $canonicalRoot "$id\agents"
    if (Test-Path $metaSrc) {
        foreach ($mf in (Get-ChildItem $metaSrc -File)) {
            $mDst = Join-Path $root ".agents\skills\$id\agents\$($mf.Name)"
            if ($Check) {
                if (-not (Test-Path $mDst)) { $issues.Add("缺失 codex metadata: $mDst") }
                elseif ((Get-FileHash $mDst -Algorithm SHA256).Hash -ne (Get-FileHash $mf.FullName -Algorithm SHA256).Hash) { $issues.Add("codex metadata 不同步: $mDst") }
                else { $ok++ }
            } else {
                New-Item -ItemType Directory -Force (Split-Path $mDst) | Out-Null
                Copy-Item $mf.FullName $mDst -Force; $written++
            }
        }
    }
    foreach ($ar in $adapterRoots) {
        $dst = Join-Path $ar "$id\SKILL.md"
        if ($Check) {
            if (-not (Test-Path $dst)) { $issues.Add("缺失适配器: $dst"); continue }
            $exactName = Get-SkillEntryExactName (Split-Path $dst -Parent)
            if ($exactName -cne 'SKILL.md') {
                $issues.Add("入口文件名大小写错误(需 SKILL.md,实际=[$exactName]): $dst")
                continue
            }
            $cur = [IO.File]::ReadAllBytes($dst)
            if ([Convert]::ToBase64String($cur) -ne [Convert]::ToBase64String($expect)) {
                # 区分：无生成标记 = 手改/旧正文；有标记但内容不符 = 陈旧
                $curText = [Text.Encoding]::UTF8.GetString($cur)
                if ($curText.Contains($MARK)) { $issues.Add("陈旧适配器(canonical 已变,需重新生成): $dst") }
                else { $issues.Add("手改/非生成内容: $dst") }
            } else { $ok++ }
        } else {
            Write-AdapterSkillMd $dst $expect
            $written++
        }
    }
}
if ($Check) {
    "check: 一致 $ok 个;问题 $($issues.Count) 个"
    $issues | Select-Object -First 20 | ForEach-Object { "  $_" }
    if ($issues.Count -gt 0) { exit 1 } else { exit 0 }
} else {
    "生成/刷新适配器 $written 个（$($ids.Count) skill × 两端）$(if ($removed -gt 0) { "; 下架清除 $removed 个" })"
    $issues | ForEach-Object { "  $_" }
    if ($issues.Count -gt 0) { exit 1 }
}
