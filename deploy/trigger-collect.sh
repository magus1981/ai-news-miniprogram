#!/bin/bash
# Trigger AI news collection via GitHub Actions (called by cron)
# 普通轮: trigger-collect.sh          （07:35/09:05/11:05/14:05/20:05/23:35 北京时间，全量42源）
# 轻量轮: trigger-collect.sh light    （02:35/05:35 北京时间，dispatch inputs.mode=light，管线只抓15个海外源）
TOKEN=$(cat /opt/ai-news/.gh-token)
MODE="${1:-full}"
PAYLOAD="{\"ref\":\"main\",\"inputs\":{\"mode\":\"$MODE\"}}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/magus1981/ai-news-miniprogram/actions/workflows/collect.yml/dispatches \
  -d "$PAYLOAD")
echo "$(date '+%F %T') mode=${1:-full} dispatched http=${HTTP_CODE}" >> /opt/ai-news/trigger-collect.log
