# bootstrap.ps1 — 首次建立/修复 .htyworkflows 目录骨架与 Agent 适配入口
# 幂等：已存在的目录与文件不会被覆盖；只补缺失结构
# 用法: .\bootstrap.ps1 [-WithAdapters]  (-WithAdapters 会调用 sync-adapters.ps1 重建两端适配器)
param([switch]$WithAdapters)
$ErrorActionPreference = 'Stop'
$w = Split-Path $PSScriptRoot -Parent   # .htyworkflows 根
$dirs = 'rules','skills','adapters\claude','adapters\codex','memory\imports','tools',
    'plans','plans_waitChoose','changeLog','changeLogHistory','chatContinue','handoff','docking',
    'svg','testKPI','userTeach','user-real-design','AgentDocument','agentsSynchronizer',
    'history\bug-records','history\tech-debt','history\legacy-plans','history\archives',
    'runtime\logs','runtime\mcp-logs','runtime\tmp','runtime\local','private','migration\manifests','migration\reports','migration\tools'
$created = 0
foreach ($d in $dirs) {
    $p = Join-Path $w $d
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force $p | Out-Null; $created++ }
}
foreach ($f in 'README.md', 'workflow-manifest.json') {
    if (-not (Test-Path (Join-Path $w $f))) { Write-Warning "缺失治理文件: $f（需从版本库或快照恢复，bootstrap 不生成内容）" }
}
Write-Host "bootstrap 完成：补建目录 $created 个（根: $w）"
if ($WithAdapters) {
    $sync = Join-Path $PSScriptRoot 'sync-adapters.ps1'
    if (Test-Path $sync) { & $sync } else { Write-Warning 'sync-adapters.ps1 尚未就位（Step 9 生成）' }
}