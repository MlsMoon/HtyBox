# path-audit.ps1 — 旧 Agent 路径语义审计：扫描 .claude/.agents 业务引用，对照 allowlist 分类
# 违规定义：活跃能力层（canonical skills/rules/memory 索引）中出现未登记的 .claude/.agents 业务路径
# 用法: .\path-audit.ps1  （退出码 0=干净, 1=有违规）
# 豁免清单（工程特有数据的配置点）：tools/path-audit-skip.json = ["skills/x/SKILL.md", ...]（env 根相对、'/' 分隔）
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

$skipJson = Join-Path $PSScriptRoot 'path-audit-skip.json'
$skipFiles = @()
if (Test-Path $skipJson) {
    $skipFiles = @((Get-Content $skipJson -Raw | ConvertFrom-Json) | ForEach-Object { Join-Path '.htyworkflows' ($_ -replace '/', '\') })
}
function Test-AllowedLine([string]$line) {
    # 产品固有：用户级 Claude 目录 / Codex home / 原生规则入口 / CLI 安装探测 / 全局 MCP 配置
    if ($line -match 'Users[/\\][^/\\]+[/\\]\.claude|~[/\\]\.claude|\.claude\.json|"\.claude", "local"|\.claude[/\\]CLAUDE\.md') { return $true }
    # 禁手改说明（适配器边界声明本身需要提及旧目录）
    if ($line -match '禁止手改|禁手改|生成薄适配器|生成适配器') { return $true }
    # 受保护宿主配置的边界声明（决策 2A：描述 settings 只读保护本身）
    if ($line -match '\.claude[/\\]settings') { return $true }
    # legacy 迁移识别语义（代码显式识别旧默认路径并跟随新默认，非业务写入）
    if ($line -match '旧默认|迁移前的旧') { return $true }
    return $false
}
# 工程代码根（如 Unity Assets）可按工程需要在此自行追加扫描项
$scanRoots = @(
    @{ path = "$root\.htyworkflows\skills"; mask = '*.md', '*.ps1', '*.py', '*.yaml' },
    @{ path = "$root\.htyworkflows\rules";  mask = '*.md' },
    @{ path = "$root\.htyworkflows\memory\MEMORY.md"; mask = $null }
)
$violations = New-Object System.Collections.Generic.List[string]
foreach ($sr in $scanRoots) {
    $items = if ($sr.mask) { Get-ChildItem $sr.path -Recurse -File -Include $sr.mask -Force -ErrorAction SilentlyContinue } else { Get-Item $sr.path }
    foreach ($f in $items) {
        $rel = $f.FullName.Substring($root.Length + 1)
        if ($rel -in $skipFiles) { continue }
        $hits = Select-String -Path $f.FullName -Pattern '\.claude[/\\]|\.agents[/\\]' -ErrorAction SilentlyContinue
        foreach ($h in $hits) {
            if (-not (Test-AllowedLine $h.Line)) {
                $violations.Add("${rel}:$($h.LineNumber): $($h.Line.Trim().Substring(0, [Math]::Min(100, $h.Line.Trim().Length)))")
            }
        }
    }
}
if ($violations.Count -eq 0) {
    Write-Host "path-audit 通过：活跃能力层无未登记的 .claude/.agents 业务引用"
    exit 0
} else {
    Write-Host "path-audit 违规 $($violations.Count) 处："
    $violations | Select-Object -First 30 | ForEach-Object { Write-Host "  $_" }
    exit 1
}