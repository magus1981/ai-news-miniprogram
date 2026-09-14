#!/usr/bin/env bash
# deploy/db-backup.sh — 在线安全备份生产 SQLite 库并轮转旧备份
# 目标环境: Ubuntu + sqlite3 + node22 (本脚本只用 sqlite3/gzip/find/awk 等基础命令)
# 建议 crontab: 30 3 * * * /opt/ai-news/deploy/db-backup.sh >> /opt/ai-news/db-backup.log 2>&1
#
# 设计要点:
#  1. 用 sqlite3 ".backup" 做在线快照, 不 cp 正在写的库, 不依赖 -wal/-shm 文件。
#  2. 快照先落在备份目录的隐藏 .tmp.db 文件上, 通过 PRAGMA integrity_check 后才 gzip。
#  3. 校验失败: 不压缩, 保留为 articles-YYYYMMDD-HHMM.failed 供人工排查, 退出码 1,
#     并打印 [BACKUP-ALERT] 醒目行(cron 日志里可直接 grep)。
#  4. 轮转(按文件名日期, 文件名定宽 articles-YYYYMMDD-HHMM.db.gz, 字典序==时间序):
#       - 保留最近 KEEP_RECENT 份;
#       - 额外永久保留"每个自然月的第一份": 同一个月内文件名最小(即最早)的那份备份
#         永不删除。例: 3 月 1 日 03:30 跑出的 articles-20260301-0330.db.gz 会作为
#         202603 的月首备份被永久保留。
set -euo pipefail

# ---------- 可调参数(环境变量可覆盖) ----------
DB="${DB:-/opt/ai-news/data/articles.db}"          # 生产库路径
BACKUP_DIR="${BACKUP_DIR:-/opt/ai-news/backups}"   # 备份存放目录
KEEP_RECENT="${KEEP_RECENT:-14}"                  # 最近保留份数
# ----------------------------------------------

TS="$(date +%Y%m%d-%H%M)"
FAILED="$BACKUP_DIR/articles-$TS.failed"          # 校验失败时保留
PLAIN="$BACKUP_DIR/articles-$TS.db"               # 校验通过后的临时明文
FINAL="$BACKUP_DIR/articles-$TS.db.gz"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB" ]; then
  echo "[BACKUP-ALERT] $(date '+%F %T') 数据库不存在: $DB" >&2
  exit 1
fi

# 0) 同一分钟重跑的短路（2026-09-14 实测缺陷）：文件名精确到分钟，
#    旧实现会 mv 出 PLAIN 后撞 gzip 的 no-clobber → 退出码 2 且留下 25MB 无人认领的
#    明文 articles-*.db（既不匹配 .tmp.db 也不匹配 .failed，清理扫不到，永久堆积）。
if [ -f "$FINAL" ]; then
  echo "skip: 本分钟已有备份 $FINAL（不做重复快照、不轮转）"
  exit 0
fi

# 1) 在线安全快照（临时名带 PID，避免并发/重跑互相踩同一文件）
TMP="$BACKUP_DIR/.articles-$TS-$$.tmp.db"
sqlite3 "$DB" ".backup $TMP"

# 2) 完整性校验(只校验快照, 不碰生产库)
IC="$(sqlite3 "$TMP" 'PRAGMA integrity_check;')"
if [ "$IC" != "ok" ]; then
  mv -n "$TMP" "$FAILED"
  echo "=================================================================="
  echo "[BACKUP-ALERT] $(date '+%F %T') integrity_check 未通过!"
  echo "[BACKUP-ALERT] 输出: $IC"
  echo "[BACKUP-ALERT] 快照已保留待排查: $FAILED (未压缩, 未轮转)"
  echo "=================================================================="
  exit 1
fi

# 3) 通过校验 -> 命名并 gzip(gzip 成功后自动删除 .db 明文)
mv -n "$TMP" "$PLAIN"
gzip "$PLAIN"
echo "backup ok: $FINAL ($(du -h "$FINAL" | cut -f1))"

# 4) 轮转: 收集全部备份按文件名倒序(最新在前)
#    计算"每份是否保留": 最近 KEEP_RECENT 份 + 每月最早一份
# shellcheck disable=SC2012
ls -1 "$BACKUP_DIR"/articles-*.db.gz 2>/dev/null | sort -r > "$BACKUP_DIR/.rotation.list" || true
KEEP_LIST="$(awk -v keep="$KEEP_RECENT" '
  {
    n++
    f[n] = $0
    # 文件名形如 articles-YYYYMMDD-HHMM.db.gz, 先剥掉目录前缀,
    # 再从第 10 个字符起取 6 位 = YYYYMM
    b = $0; sub(/.*\//, "", b)
    m = substr(b, 10, 6)
    # 倒序(新→旧)遍历并持续覆盖 => 每月最终留下的就是"当月第一份"(最早)备份
    keeper_of_month[m] = $0
  }
  END {
    for (i = 1; i <= n; i++) if (i <= keep) print f[i]
    for (m in keeper_of_month) print keeper_of_month[m]
  }' "$BACKUP_DIR/.rotation.list")"

# ── 轮转前的"防误清"守卫（与本项目 sync-upload 同思路：宁可不删，不可删光）──
# KEEP_LIST 由 awk 从文件名列表推导；一旦 awk 出错/列表为空，下面的 case 将永不匹配，
# 后果是把 backups/ 里所有历史备份一次删光 —— 备份脚本自身绝不能成为数据丢失源。
KEPT_COUNT="$(printf '%s\n' "$KEEP_LIST" | grep -c . || true)"
if [ "$KEPT_COUNT" -lt 2 ]; then
  echo "[BACKUP-ALERT] $(date '+%F %T') 轮转跳过：保留清单只有 ${KEPT_COUNT} 项，异常偏少，不删任何备份" >&2
  rm -f "$BACKUP_DIR/.rotation.list"
  exit 1
fi
case "$KEEP_LIST" in
  *"$FINAL"*) ;;
  *)
    echo "[BACKUP-ALERT] $(date '+%F %T') 轮转跳过：本次新备份不在保留清单内，异常，不删任何备份" >&2
    rm -f "$BACKUP_DIR/.rotation.list"
    exit 1
    ;;
esac

while IFS= read -r f; do
  case "$KEEP_LIST" in *"$f"*) ;; *)
    echo "rotate: delete old backup $(basename "$f")"
    rm -f -- "$f"
    ;;
  esac
done < "$BACKUP_DIR/.rotation.list"

# 清理滞留的中间产物：崩溃/校验失败留下的 .tmp 快照与 .failed 快照（7 天后无排查价值）
find "$BACKUP_DIR" -maxdepth 1 \( -name '.articles-*.tmp.db' -o -name 'articles-*.failed' \) -mtime +7 -type f -delete 2>/dev/null || true
# 无人认领的明文快照（gzip 中断/磁盘满遗留）：只清 60 分钟前的，避开可能并发的实例
find "$BACKUP_DIR" -maxdepth 1 -name 'articles-*.db' -type f -mmin +60 \
  ! -exec test -e '{}.gz' \; -delete 2>/dev/null || true
rm -f "$BACKUP_DIR/.rotation.list"

# 5) 统计
COUNT="$(ls -1 "$BACKUP_DIR"/articles-*.db.gz 2>/dev/null | wc -l)"
SIZE="$(du -sh "$BACKUP_DIR" | cut -f1)"
echo "backups now: ${COUNT} kept, total ${SIZE} in ${BACKUP_DIR}"
exit 0
