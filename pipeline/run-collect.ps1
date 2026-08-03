# 本地兜底采集脚本（供 Windows 计划任务 AINewsCollect 调用）
# 云端 GitHub Actions 就绪后可删除该任务：Unregister-ScheduledTask -TaskName AINewsCollect -Confirm:$false
$ErrorActionPreference = "Continue"
$dir = "d:\20260402qoder\ai-news-miniprogram\pipeline"
$log = Join-Path $dir "collect-cron.log"
Set-Location $dir
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $log -Value "`n========== [$stamp] 定时采集开始 ==========" -Encoding utf8
& "C:\Program Files\nodejs\node.exe" collect.mjs *>> $log
$code = $LASTEXITCODE
# 采集完成后推送到生产服务器（未配置 SYNC_URL/SYNC_TOKEN 时自动跳过）
& "C:\Program Files\nodejs\node.exe" sync-push.mjs *>> $log
$stamp2 = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $log -Value "========== [$stamp2] 定时采集结束 (exit=$code) ==========" -Encoding utf8
