#!/usr/bin/env bash
# 02-diag-imgvideo.sh — EU sandbox read-only diagnostics: image/video plugins.
#
# Checks img-ops.ts (TG image -> workspace source-latest.png -> img_ops(info|resize|
# rotate|crop|grayscale|invert), pure ffmpeg CLI) and img-lab.ts (TG video ->
# source-latest.mp4 -> img_lab(info|trim|scale|frame|mute|rotate), pure ffmpeg CLI).
#
# READ-ONLY. It never modifies an EU file/service/DB/container, never enters
# /srv/tenants, never restarts a container and never sends a Telegram message.
# The only write is a throwaway PNG inside the container's /tmp, removed in the
# same command; no external API call is made by this script.
#
# Usage: bash 02-diag-imgvideo.sh [--off]

VERSION='1.1.0'

set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_lib.sh
. "$SELF_DIR/_lib.sh" || { printf 'FATAL: cannot source %s/_lib.sh\n' "$SELF_DIR"; exit 2; }

OFF=0
for arg in "$@"; do
  case "$arg" in
    --off) OFF=1 ;;
    -h|--help)
      printf 'usage: bash %s [--off]\n  --off  skip external-API live items (this script has none; accepted for symmetry)\n' "$(basename "$0")"
      exit 0 ;;
    *) printf 'unknown argument: %s (use --off)\n' "$arg" >&2; exit 2 ;;
  esac
done

IMG_OPS_CT="$PLUGIN_DIR/img-ops.ts"
IMG_LAB_CT="$PLUGIN_DIR/img-lab.ts"
IMG_OPS_HOST="$PATCH_DIR/img-ops.ts"
IMG_LAB_HOST="$PATCH_DIR/img-lab.ts"
BOT_HOST="$PATCH_DIR/bot.ts"

printf '=== 02-diag-imgvideo.sh — EU img-ops / img-lab read-only diagnostics ===\n'
print_version "$VERSION"
printf 'mode: %s | patches: %s | container: %s:%s\n\n' \
  "$([ "$OFF" -eq 1 ] && echo 'local-only (--off)' || echo 'full (no live API items remain)')" \
  "$PATCH_DIR" "$CONTAINER" "$PLUGIN_DIR"

# --------------------------------------------------------------------------
# 1. ffmpeg-bin — the whole img-ops/img-lab chain shells out to ffmpeg/ffprobe.
# --------------------------------------------------------------------------
printf -- '--- 1. ffmpeg-bin ---\n'
ffmpeg_bin_check

# --------------------------------------------------------------------------
# 2. files — line counts of the loaded plugins; host patches are informational
#    only (missing mount = WARN, never FAIL: image-built files are legitimate).
# --------------------------------------------------------------------------
printf -- '\n--- 2. files ---\n'
file_lines_check "$IMG_OPS_CT" 242
file_lines_check "$IMG_LAB_CT" 302
for pair in "img-ops.ts:$IMG_OPS_HOST" "img-lab.ts:$IMG_LAB_HOST"; do
  name=${pair%%:*}; host=${pair#*:}
  if [ -f "$host" ]; then
    h=$($DOCKER exec "$CONTAINER" md5sum "${PLUGIN_DIR}/${name}" 2>/dev/null | awk '{print $1}')
    hm=$(md5sum "$host" | awk '{print $1}')
    if [ -n "$h" ] && [ "$h" = "$hm" ]; then
      pass "files — $name host patch mirrors the loaded file ($hm)"
    else
      warn "files — $name host patch differs from the loaded file (host=$hm container=${h:-unreadable})"
    fi
  else
    warn "files — $name not under $PATCH_DIR (baked into the image, not mounted; a change needs an image rebuild or a new mount)"
  fi
done

# --------------------------------------------------------------------------
# 3. ffmpeg-microtest — zero-side-effect PNG encode inside the container /tmp.
# --------------------------------------------------------------------------
printf -- '\n--- 3. ffmpeg-microtest ---\n'
if ! $DOCKER exec "$CONTAINER" sh -c 'command -v ffmpeg' >/dev/null 2>&1; then
  fail "ffmpeg-microtest — skipped: ffmpeg is not present in $CONTAINER (see ffmpeg-bin)"
else
  MT=$($DOCKER exec "$CONTAINER" sh -c \
    'ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=10 -frames:v 1 /tmp/diag-test.png 2>/dev/null && head -c 8 /tmp/diag-test.png | od -A n -t x1 && rm -f /tmp/diag-test.png' 2>&1)
  printf '  od output: %s\n' "$(printf '%s' "$MT" | tr -s ' \n' ' ')"
  if printf '%s' "$MT" | grep -q '89 50 4e 47'; then
    pass "ffmpeg-microtest — PNG magic 89 50 4e 47 produced by the container's ffmpeg (temp file removed)"
  else
    fail "ffmpeg-microtest — no PNG magic in ffmpeg output: $(printf '%s' "$MT" | tr -s ' \n' ' ' | truncate_text 200)"
  fi
fi

# --------------------------------------------------------------------------
# 4. tg-source-entry — img plugins depend on bot.ts downloading TG media into
#    the event; zero matches means the base64 input source is gone.
# --------------------------------------------------------------------------
printf -- '\n--- 4. tg-source-entry ---\n'
TG_RE='imageMessage|videoMessage|ev\.images|m\.video|getFile'
if [ ! -f "$BOT_HOST" ]; then
  fail "tg-source-entry — source file missing: $BOT_HOST"
  usage_hint "$BOT_HOST" "$PLUGIN_DIR/bot.ts"
else
  TG_MATCHES=$(grep -nE "$TG_RE" "$BOT_HOST" | head -n 20)
  if [ -n "$TG_MATCHES" ]; then
    printf '%s\n' "$TG_MATCHES"
    pass "tg-source-entry — $(printf '%s\n' "$TG_MATCHES" | wc -l | tr -d ' ') matching lines in $BOT_HOST"
  else
    fail "tg-source-entry — zero matches for '$TG_RE' in $BOT_HOST (img/video plugins get no base64 input)"
    grep_report "$TG_RE" "$BOT_HOST"
    printf '       hint: check the real bot entrypoint name under %s\n' "$PATCH_DIR"
  fi
fi

# --------------------------------------------------------------------------
# 5. smoke — bun imports both plugins in the container, each in its own try/catch.
# --------------------------------------------------------------------------
printf -- '\n--- 5. smoke ---\n'
smoke_or_fallback 'imgvideo' "$IMG_OPS_CT" "$IMG_LAB_CT"

# --------------------------------------------------------------------------
printf '\nSUMMARY: %d PASS / %d FAIL / %d WARN\n' "$PASS_N" "$FAIL_N" "$WARN_N"
if [ "$FAIL_N" -eq 0 ]; then exit 0; else exit 1; fi
