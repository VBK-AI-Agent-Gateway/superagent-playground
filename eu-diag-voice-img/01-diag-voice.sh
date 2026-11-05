#!/usr/bin/env bash
# 01-diag-voice.sh — EU sandbox read-only diagnostics: voice chain (STT + TTS).
#
# Checks aa-voice.ts (TG voice -> base64 -> DeepInfra Whisper large v3 turbo) and
# aa-tts.ts ([VOICE:text] -> hosted TTS -> sendVoice) on the wagate host.
#
# READ-ONLY. It never modifies an EU file/service/DB/container, never reads
# /srv/tenants, never restarts a container and never sends a Telegram message.
# The only external calls are the two declared live probes (stt-live, tts-live),
# each exactly one POST, skipped entirely with --off.
#
# Usage: bash 01-diag-voice.sh [--off]

VERSION='1.0.0'

set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_lib.sh
. "$SELF_DIR/_lib.sh" || { printf 'FATAL: cannot source %s/_lib.sh\n' "$SELF_DIR"; exit 2; }

OFF=0
for arg in "$@"; do
  case "$arg" in
    --off) OFF=1 ;;
    -h|--help)
      printf 'usage: bash %s [--off]\n  --off  skip external-API live items (stt-live, tts-live)\n' "$(basename "$0")"
      exit 0 ;;
    *) printf 'unknown argument: %s (use --off)\n' "$arg" >&2; exit 2 ;;
  esac
done

VOICE_HOST="$PATCH_DIR/aa-voice.ts"
TTS_HOST="$PATCH_DIR/aa-tts.ts"
VOICE_CT="$PLUGIN_DIR/aa-voice.ts"
TTS_CT="$PLUGIN_DIR/aa-tts.ts"

printf '=== 01-diag-voice.sh — EU voice chain (STT + TTS) read-only diagnostics ===\n'
print_version "$VERSION"
printf 'mode: %s | patches: %s | container: %s:%s\n\n' \
  "$([ "$OFF" -eq 1 ] && echo 'local-only (--off)' || echo 'full (live API probes enabled)')" \
  "$PATCH_DIR" "$CONTAINER" "$PLUGIN_DIR"

# --------------------------------------------------------------------------
# 1. mount-md5 — host patch must be byte-identical to the loaded container copy.
# --------------------------------------------------------------------------
printf -- '--- 1. mount-md5 ---\n'
MD5_OK=1
for pair in "aa-voice.ts:$VOICE_HOST:$VOICE_CT" "aa-tts.ts:$TTS_HOST:$TTS_CT"; do
  name=${pair%%:*}; rest=${pair#*:}; host=${rest%%:*}; ct=${rest#*:}
  if [ ! -f "$host" ]; then
    fail "mount-md5 — host file missing: $host"
    usage_hint "$host" "$ct"
    MD5_OK=0
    continue
  fi
  h=$(md5sum "$host" 2>/dev/null | awk '{print $1}')
  c=$($DOCKER exec "$CONTAINER" md5sum "$ct" 2>/dev/null | awk '{print $1}')
  if [ -z "$c" ]; then
    fail "mount-md5 — $name: cannot md5sum $ct inside container $CONTAINER"
    MD5_OK=0
  elif [ "$h" = "$c" ]; then
    pass "mount-md5 — $name host=container ($h)"
  else
    fail "mount-md5 — $name differs: host=$h container=$c (loaded code is NOT the host patch)"
    MD5_OK=0
  fi
done

# --------------------------------------------------------------------------
# 2. stt-key — shared DeepInfra key file present and non-empty (masked output).
# --------------------------------------------------------------------------
printf -- '\n--- 2. stt-key ---\n'
STT_KEY_OK=0
if check_key_file "$STT_KEY_FILE"; then
  STT_KEY_OK=1
fi

# --------------------------------------------------------------------------
# 3. stt-endpoint — endpoint + model grepped from the plugin source at runtime.
# --------------------------------------------------------------------------
printf -- '\n--- 3. stt-endpoint ---\n'
STT_RE='https://[^"'"'"'` ]+'
STT_MODEL_RE='whisper'
if [ ! -f "$VOICE_HOST" ]; then
  fail "stt-endpoint — cannot grep $VOICE_HOST (file missing; see mount-md5 above)"
  grep_report "$STT_RE" "$VOICE_HOST"
  STT_ENDPOINT=''
elif ! grep -qE "$STT_RE" "$VOICE_HOST"; then
  fail "stt-endpoint — no https endpoint found in $VOICE_HOST"
  grep_report "$STT_RE" "$VOICE_HOST"
  printf '       actual grep output: (no match, exit %s)\n' "$?"
  STT_ENDPOINT=''
else
  STT_MATCHES=$(extract_config "$VOICE_HOST" "$STT_RE" endpoint)
  STT_MODEL=$(extract_model "$VOICE_HOST" "$STT_MODEL_RE")
  printf '%s\n' "$STT_MATCHES"
  if [ -n "$STT_MODEL" ]; then
    printf '  model: %s\n' "$STT_MODEL"
  else
    warn "stt-endpoint — no whisper model string matched; grep: grep -niE '$STT_MODEL_RE' $VOICE_HOST"
  fi
  STT_ENDPOINT=$(grep -Eo "$STT_RE" "$VOICE_HOST" \
    | grep -Ei '/(inference|v1)/' \
    | grep -Ei 'whisper|transcri|stt|audio|speech' \
    | clean_url | sort -u | head -n1)
  [ -n "$STT_ENDPOINT" ] || STT_ENDPOINT=$(grep -Eo "$STT_RE" "$VOICE_HOST" | grep -Ei '/(inference|v1)/' | clean_url | sort -u | head -n1)
  if [ -n "$STT_ENDPOINT" ]; then
    pass "stt-endpoint — extracted from source: $STT_ENDPOINT"
  else
    fail "stt-endpoint — endpoint regex matched but no usable URL extracted from $VOICE_HOST"
  fi
fi

# --------------------------------------------------------------------------
# 4. stt-live (--off skips) — one POST of a synthesized 1s 440Hz WAV, base64 JSON.
#    Request shape follows the actual call in aa-voice.ts (see README).
# --------------------------------------------------------------------------
printf -- '\n--- 4. stt-live ---\n'
if [ "$OFF" -eq 1 ]; then
  warn "stt-live — skipped (--off): no external API call was made"
elif [ -z "$STT_ENDPOINT" ]; then
  fail "stt-live — skipped: no endpoint could be extracted from $VOICE_HOST"
elif [ "$STT_KEY_OK" -ne 1 ]; then
  fail "stt-live — skipped: key file $STT_KEY_FILE unusable (see stt-key)"
elif ! command -v python3 >/dev/null 2>&1; then
  fail "stt-live — skipped: python3 not available on the host to synthesize the test WAV"
else
  # The helper reads the key itself from the file; it never reaches argv. The
  # model is whatever section 3 extracted from the source tree — there is no
  # built-in default, so a missing value is reported rather than guessed.
  if [ -z "$STT_MODEL" ]; then
    fail "stt-live — skipped: no model literal could be extracted from $VOICE_HOST (see stt-endpoint)"
  else
    stt_live "$STT_ENDPOINT" "$STT_MODEL" "$STT_KEY_FILE"
  fi
fi

# --------------------------------------------------------------------------
# 5. tts-endpoint — endpoint + model grepped from aa-tts.ts at runtime.
# --------------------------------------------------------------------------
printf -- '\n--- 5. tts-endpoint ---\n'
TTS_RE='https://[^"'"'"'` ]+'
TTS_MODEL_RE='[Qq]wen'
if [ ! -f "$TTS_HOST" ]; then
  fail "tts-endpoint — cannot grep $TTS_HOST (file missing; see mount-md5 above)"
  grep_report "$TTS_RE" "$TTS_HOST"
  TTS_ENDPOINT=''
elif ! grep -qE "$TTS_RE" "$TTS_HOST"; then
  fail "tts-endpoint — no https endpoint found in $TTS_HOST"
  grep_report "$TTS_RE" "$TTS_HOST"
  printf '       actual grep output: (no match)\n'
  TTS_ENDPOINT=''
else
  printf '%s\n' "$(extract_config "$TTS_HOST" "$TTS_RE" endpoint)"
  TTS_MODEL=$(extract_model "$TTS_HOST" "$TTS_MODEL_RE")
  if [ -n "$TTS_MODEL" ]; then
    printf '  model: %s\n' "$TTS_MODEL"
  else
    warn "tts-endpoint — no Qwen* model string matched; grep: grep -niE '$TTS_MODEL_RE' $TTS_HOST"
  fi
  TTS_ENDPOINT=$(grep -Eo "$TTS_RE" "$TTS_HOST" \
    | grep -Ei '/(inference|v1)/' \
    | grep -Ei 'speech|tts|audio|voice' \
    | clean_url | sort -u | head -n1)
  [ -n "$TTS_ENDPOINT" ] || TTS_ENDPOINT=$(grep -Eo "$TTS_RE" "$TTS_HOST" | grep -Ei '/(inference|v1)/' | clean_url | sort -u | head -n1)
  if [ -n "$TTS_ENDPOINT" ]; then
    pass "tts-endpoint — extracted from source: $TTS_ENDPOINT"
  else
    fail "tts-endpoint — endpoint regex matched but no usable URL extracted from $TTS_HOST"
  fi
fi

# --------------------------------------------------------------------------
# 6. tts-live (--off skips) — one POST of a short Chinese text; expect HTTP 200,
#    OggS magic and >1KiB. The response body is discarded, never written to disk.
# --------------------------------------------------------------------------
printf -- '\n--- 6. tts-live ---\n'
if [ "$OFF" -eq 1 ]; then
  warn "tts-live — skipped (--off): no external API call was made"
elif [ -z "$TTS_ENDPOINT" ]; then
  fail "tts-live — skipped: no endpoint could be extracted from $TTS_HOST"
elif [ "$STT_KEY_OK" -ne 1 ]; then
  fail "tts-live — skipped: key file $STT_KEY_FILE unusable (see stt-key)"
else
  if [ -z "$TTS_MODEL" ]; then
    fail "tts-live — skipped: no model literal could be extracted from $TTS_HOST (see tts-endpoint)"
  else
    tts_live "$TTS_ENDPOINT" "$TTS_MODEL" "$STT_KEY_FILE"
  fi
fi

# --------------------------------------------------------------------------
# 7. tg-bot — Bot API getMe; proves the token in /etc/wagate.env is live.
#    getMe sends no message to any chat, so no TG traffic beyond this call.
# --------------------------------------------------------------------------
printf -- '\n--- 7. tg-bot ---\n'
if [ ! -f "$WAGATE_ENV_FILE" ]; then
  fail "tg-bot — env file missing: $WAGATE_ENV_FILE"
elif ! grep -q '^TELEGRAM_BOT_TOKEN=' "$WAGATE_ENV_FILE"; then
  fail "tg-bot — TELEGRAM_BOT_TOKEN not found in $WAGATE_ENV_FILE"
else
  TG_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$WAGATE_ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' \r\n')
  printf '  token: %s%s(len=%s)\n' "${TG_TOKEN:0:4}" "$(printf '\u2026')" "${#TG_TOKEN}"
  if [ -z "$TG_TOKEN" ]; then
    fail "tg-bot — TELEGRAM_BOT_TOKEN is empty in $WAGATE_ENV_FILE"
  else
    # -o keeps the response body separate from any diagnostics, so the check
    # below only ever inspects Telegram's reply.
    TG_TMP=$(mktemp)
    TG_CODE=$(curl -sS --connect-timeout 5 --max-time 15 -o "$TG_TMP" -w '%{http_code}' \
      "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null)
    TG_RC=$?
    TG_RESP=$(cat "$TG_TMP" 2>/dev/null); rm -f "$TG_TMP"
    if printf '%s' "$TG_RESP" | grep -q '"ok":true'; then
      pass "tg-bot — getMe ok (HTTP $TG_CODE): $(printf '%s' "$TG_RESP" | truncate_text 160)"
    elif [ "$TG_RC" -ne 0 ]; then
      fail "tg-bot — getMe could not reach api.telegram.org (curl exit $TG_RC): $(printf '%s' "$TG_RESP" | truncate_text 160)"
      printf '       note: a network/DNS block also fails the voice chain, so check egress from this host before blaming the token\n'
    else
      fail "tg-bot — getMe returned an error (HTTP $TG_CODE): $(printf '%s' "$TG_RESP" | truncate_text 200)"
    fi
  fi
  unset TG_TOKEN
fi

# --------------------------------------------------------------------------
# 8. smoke — bun imports both plugins in the container, each in its own try/catch.
#    bun missing degrades to a file-existence check + WARN.
# --------------------------------------------------------------------------
printf -- '\n--- 8. smoke ---\n'
smoke_or_fallback 'voice' "$VOICE_CT" "$TTS_CT"

# --------------------------------------------------------------------------
printf '\nSUMMARY: %d PASS / %d FAIL / %d WARN\n' "$PASS_N" "$FAIL_N" "$WARN_N"
if [ "$FAIL_N" -eq 0 ]; then exit 0; else exit 1; fi
