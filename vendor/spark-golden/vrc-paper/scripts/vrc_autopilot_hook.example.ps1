# vrc_autopilot_hook.example.ps1
# 复制为 vrc_autopilot_hook.ps1 后按需改写。
# 由 vrc_autopilot_loop.ps1 -HookScript 调用，参数：
#   -ResultsRoot, -OrchestratorExitCode, -Attempt
#
# 示例用途：
#   A) 把摘要追加到固定文件，供你打开 Cursor 手动粘贴 CURSOR_PROMPT_AUTOPILOT.txt
#   B) 若已安装 @cursor/sdk 且配置 CURSOR_API_KEY，可在此调用 node 子脚本触发 Agent.prompt（自管依赖与 dispose）
#
param(
    [Parameter(Mandatory = $true)][string]$ResultsRoot,
    [Parameter(Mandatory = $true)][int]$OrchestratorExitCode,
    [Parameter(Mandatory = $true)][int]$Attempt,
    [string]$RepoRoot = ""
)

$stamp = Get-Date -Format "s"
$sessionParent = Split-Path $ResultsRoot -Parent
$out = Join-Path $sessionParent "HOOK_QUEUE.md"
$repoGuess = if ($RepoRoot) { $RepoRoot } else { Split-Path (Split-Path (Split-Path $ResultsRoot -Parent) -Parent) -Parent }
$prompt = Join-Path $repoGuess "vrc-paper\scripts\CURSOR_PROMPT_AUTOPILOT.txt"
Add-Content -Path $out -Value @"

## $stamp attempt=$Attempt exit=$OrchestratorExitCode
- ResultsRoot: ``$ResultsRoot``
- RepoRoot (guess): ``$repoGuess``
- Prompt file: ``$prompt``

"@
