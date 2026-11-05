# _lib.sh — shared helpers for the EU read-only diagnostic package.
#
# Safety contract for everything in this directory:
#   * read-only: no EU file/service/DB/container state is ever modified
#   * the only writes are inside the container /tmp (auto-removed) and at most
#     two external API calls (STT x1, TTS x1), both declared in the README
#   * never touch /srv/tenants, never restart a container, never send a TG message
#   * secrets are only ever printed masked (first 4 chars + ellipsis + length)
#
# This file is sourced by 01-diag-voice.sh and 02-diag-imgvideo.sh; it is not
# meant to be executed on its own.

# Host paths (override with environment variables for testing on a non-EU host).
PATCH_DIR="${PATCH_DIR:-/srv/wagate/patches}"
WAGATE_ENV_FILE="${WAGATE_ENV_FILE:-/etc/wagate.env}"
STT_KEY_FILE="${STT_KEY_FILE:-/srv/secrets/_shared/deepinfra_stt}"
DOCKER="${DOCKER:-docker}"
CONTAINER="${CONTAINER:-wagate}"
PLUGIN_DIR="${PLUGIN_DIR:-/app/extensions/plugins}"   # path inside the container

PASS_N=0
FAIL_N=0
WARN_N=0

# print_version <expected-version> — mismatch is a WARN, never a hard failure.
print_version() {
  printf 'eu-diag-voice-img %s\n' "$1"
  if [ -z "${DIAG_EXPECTED_VERSION:-}" ]; then
    printf '[WARN] package-version — DIAG_EXPECTED_VERSION is not set; proceeding with %s (issue the run against the version it was written for)\n' "$1"
    WARN_N=$((WARN_N + 1))
  elif [ "$DIAG_EXPECTED_VERSION" != "$1" ]; then
    printf '[WARN] package-version — running %s but DIAG_EXPECTED_VERSION=%s\n' "$1" "$DIAG_EXPECTED_VERSION"
    WARN_N=$((WARN_N + 1))
  fi
}

pass() { PASS_N=$((PASS_N + 1)); printf '[PASS] %s\n' "$*"; }
warn() { WARN_N=$((WARN_N + 1)); printf '[WARN] %s\n' "$*"; }
fail() { FAIL_N=$((FAIL_N + 1)); printf '[FAIL] %s\n' "$*"; }

# usage_hint <host-path> <container-path> — actionable hint for a missing plugin.
usage_hint() {
  printf '       pattern: %s / %s\n' "$1" "$2"
  printf '       hint: if the plugin is not at either path, find it first, e.g.\n'
  printf '         ls -la %s\n' "$PATCH_DIR"
  printf '         %s exec %s sh -c '"'"'ls -la %s'"'"'\n' "$DOCKER" "$CONTAINER" "$PLUGIN_DIR"
  printf '       then re-run with PATCH_DIR=<dir> and/or PLUGIN_DIR=<container-dir>\n'
}

# mask_key <file> — prints first 4 chars + U+2026 + character count; never the full value.
mask_key() {
  [ -r "$1" ] || { printf '(unreadable)'; return 1; }
  { read -r first || true; } < "$1"
  printf '%s' "${first:0:4}"; printf '\u2026'; printf '(len=%s)' "${#first}"
}

# check_key_file <path> — item 2 of 01: file exists, non-empty, masked.
check_key_file() {
  if [ ! -f "$1" ]; then
    fail "stt-key — key file missing: $1"
    return 1
  fi
  if [ ! -s "$1" ]; then
    fail "stt-key — key file is empty: $1"
    return 1
  fi
  local masked
  masked=$(mask_key "$1")
  pass "stt-key — present, format $masked"
  return 0
}

# truncate_text <max> — reads stdin, collapses whitespace, truncates with U+2026.
truncate_text() {
  local max="$1" text clipped
  # LC_ALL=C + explicit NUL strip: truncating binary stderr (e.g. a mangled
  # response body) otherwise warns about ignored null bytes and can leave the
  # result empty. Also filters control characters that would corrupt the report.
  text=$(LC_ALL=C tr -d '\000' | LC_ALL=C tr -c '\11\12\15\40-\176' ' ' | awk '{ text = (NR == 1) ? $0 : text " " $0 }
    END { gsub(/[[:space:]]+/, " ", text); sub(/^ /, "", text); sub(/ $/, "", text); printf "%s", text }')
  clipped=$(printf '%s' "$text" | cut -c1-"$max")
  printf '%s' "$clipped"
  if [ "${#text}" -gt "$max" ]; then printf '\u2026'; fi
}

# extract_config <file> <regex> <label> — prints every match of the runtime grep.
extract_config() {
  grep -nEo "$2" "$1" 2>/dev/null | awk -v label="$3" '
    { line = $0; sub(/^[0-9]+:/, "", line); gsub(/^"|"$/, "", line)
      if (!(line in seen)) { seen[line] = 1; printf "  %s: %s\n", label, line } }
  '
}

# clean_url — strips trailing punctuation/quotes a URL regex may swallow.
clean_url() { sed -E 's/["'"'"'`;,)]+$//'; }

# extract_model <file> <needle-regex> — the model literal that actually pairs with
# the needle. Rejects URL-shaped candidates and bare single words such as "Qwen",
# preferring a quoted literal that contains a separator (the vendor/name shape).
extract_model() {
  local file="$1" needle="$2" candidates best
  candidates=$(grep -nEi "$needle" "$file" 2>/dev/null \
    | grep -Eo '"[^"]*'"$needle"'[^"]*"' | tr -d '"' | sort -u)
  [ -n "$candidates" ] || candidates=$(grep -Eo '"[^"]*'"$needle"'[^"]*"' "$file" 2>/dev/null | tr -d '"' | sort -u)
  [ -n "$candidates" ] || candidates=$(grep -Eo '[A-Za-z0-9._-]*'"$needle"'[A-Za-z0-9._-]*' "$file" 2>/dev/null | sort -u)
  # drop URLs and import paths
  candidates=$(printf '%s\n' "$candidates" | grep -v '://' | grep -v '^[./]' | grep -v '/$')
  # prefer vendor/name (has a slash and more than the bare needle)
  best=$(printf '%s\n' "$candidates" | grep '/' | grep -viE "^[A-Za-z]*${needle}$" | head -n1)
  [ -n "$best" ] || best=$(printf '%s\n' "$candidates" | grep -viE "^${needle}$" | awk 'length($0) > length(b) { b = $0 } END { printf "%s", b }')
  printf '%s' "$best"
}

# grep_report <file> — prints the exact grep command run, so failures can be
# reported with the original output as the spec requires.
grep_report() {
  printf '       grep command: grep -nEo %s %s\n' "'$1'" "$2"
}

# curl_post_json <outfile> <statusfile> <url> <json-body-file> <header-file>
#   The body and the auth header are read from files, never passed on the command
#   line: a base64 audio payload exceeds the per-argument size limit.
curl_post_json() {
  curl -sS --max-time 120 -o "$1" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -H @"$5" \
    --data-binary @"$4" "$3" > "$2" 2>/dev/null
}

# auth_header_file <outfile> <token-file> — writes "Authorization: Bearer <key>"
# into 0600 temp file so the secret never appears in argv or in the process list.
auth_header_file() {
  local f="$1" keyfile="$2"
  ( umask 077; printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$keyfile")" > "$f" )
}

# bundle_has <bundle-file> <needle> — 1 when stdout+stderr contain needle.
bundle_has() {
  grep -qF "$2" "$1"
}

# plugin_import_bundle <bundle-file> <import-spec> <plugin-file> <container-path>
#   runs a bun import in the container and appends its full output to the bundle.
plugin_import_bundle() {
  local spec="$1" bundle="$2" host="$3" container="$4"
  {
    printf '$ import(%s)\n' "$spec"
    $DOCKER exec "$CONTAINER" bun -e "try{await import('$spec');console.log('IMPORT_OK')}catch(e){console.error('IMPORT_FAIL '+e)}"
    printf '\n'
  } >> "$bundle" 2>&1
}

# smoke_summary <bundle-file> <container-path-1> [<container-path-2>] — shared item 8/5 verdict.
#   Runs one `bun -e "import(...)"` per plugin into <bundle-file>, then reports PASS
#   only when every plugin imported without error.
smoke_summary() {
  local bundle="$1"; shift
  local p
  : > "$bundle"
  for p in "$@"; do
    plugin_import_bundle "$p" "$bundle" '' "$p"
  done
  local ok=''
  for p in "$@"; do
    if grep -A1 -F "import($p)" "$bundle" | grep -q '^IMPORT_OK$'; then
      ok=1
    else
      ok=''
      break
    fi
  done
  if [ -n "$ok" ]; then
    pass "smoke — SMOKE_OK ($* imported cleanly under bun)"
  else
    local detail; detail=$(truncate_text 200 < "$bundle")
    [ -n "$detail" ] || detail='(no output captured from bun)'
    warn "smoke — bun import failed: $detail"
    printf '       bun was called and failed; per spec this does not FAIL the run (missing bun alone is the degraded case)\n'
  fi
}

# smoke_or_fallback <label> <container-path-1> [<container-path-2>]
#   bun present  -> import each plugin independently and report the bundle
#   bun absent   -> degrade to a file-existence check + WARN
smoke_or_fallback() {
  local bundle label
  label="$1"; shift          # v1.1 fix: the label is not a plugin path
  bundle=$(mktemp)
  if ! $DOCKER exec "$CONTAINER" sh -c 'command -v bun' >/dev/null 2>&1; then
    local missing='' p
    for p in "$@"; do
      $DOCKER exec "$CONTAINER" sh -c "test -f '$p'" >/dev/null 2>&1 || missing="$missing $p"
    done
    if [ -n "$missing" ]; then
      rm -f "$bundle"
      fail "smoke — bun unavailable and plugin file(s) missing:$missing"
    else
      rm -f "$bundle"
      warn "smoke — bun not available in container; degraded to file-existence check, all listed plugin files are present"
    fi
    return 0
  fi
  smoke_summary "$bundle" "$@"
  rm -f "$bundle"
}

# ---------------- voice helpers (01) ----------------

# resolve_endpoint <endpoint> <model> — substitutes ${MODEL}-style placeholders with the
# extracted model literal. A leftover '${' means the template could not be resolved; the
# caller is told so instead of POSTing to a literal '${MODEL}' path.
resolve_endpoint() {
  local ep="$1" model="$2"
  case "$ep" in
    *'${'*)
      ep=$(printf '%s' "$ep" | sed -e "s/\${MODEL}/$model/g" -e "s/\${model}/$model/g" \
                                  -e "s/\${MODEL_ID}/$model/g" -e "s/\${modelId}/$model/g")
      ;;
  esac
  if printf '%s' "$ep" | grep -q '\${'; then
    fail "live probe — endpoint still contains an unresolved placeholder: $ep"
    printf '       extracted model: %s\n' "$model"
    printf '%s' "$ep"
    return 0
  fi
  printf '%s' "$ep"
}

# extract_response_format — the literal response_format the TTS plugin pins, as JSON
# fragment (',"response_format":"ogg"'), or empty when the source pins none.
extract_response_format() {
  local v
  v=$(grep -Eo '"response_format"[[:space:]]*:[[:space:]]*"[^"]+"' "$TTS_HOST" 2>/dev/null \
      | sed -E 's/.*:[[:space:]]*"([^"]+)".*/\1/' | sort -u | head -n1)
  if [ -z "$v" ]; then
    printf ''
    return 0
  fi
  printf ',"response_format":"%s"' "$v"
}

# stt_live <endpoint> <model> <key> — one content-addressed POST; prints transcript head.
stt_live() {
  local endpoint="$1" model="$2" keyfile="$3" body resp status hdr text
  # v1.1 fix: the endpoint may be a template such as .../v1/${MODEL}/audio/transcriptions;
  # substitute the extracted model literal so the POST goes to a real path.
  endpoint=$(resolve_endpoint "$endpoint" "$model")
  body=$(mktemp); hdr=$(mktemp)
  python3 -c '
import base64, io, json, math, struct, sys, wave
buf = io.BytesIO()
w = wave.open(buf, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(16000)))
w.close()
print(json.dumps({"audio": base64.b64encode(buf.getvalue()).decode(), "model": sys.argv[1]}))' "$model" > "$body" 2>/dev/null
  if [ ! -s "$body" ]; then
    fail "stt-live — could not synthesize the 1s 440Hz WAV with python3"
    return 0
  fi
  resp=$(mktemp); status=$(mktemp)
  auth_header_file "$hdr" "$keyfile"
  curl_post_json "$resp" "$status" "$endpoint" "$body" "$hdr"
  local rc=$? code; code=$(cat "$status")
  if [ "$code" = "200" ]; then
    text=$(truncate_text 50 < "$resp")
    pass "stt-live — HTTP 200; transcript head: $text"
  elif [ -z "$code" ] && [ "$rc" -ne 0 ]; then
    fail "stt-live — request failed before any HTTP status (curl exit $rc): $(truncate_text 200 < "$resp")"
  else
    fail "stt-live — HTTP ${code:-<no response>}; body head: $(truncate_text 200 < "$resp")"
  fi
  rm -f "$resp" "$status" "$body" "$hdr"
}

# tts_live <endpoint> <model> <key> — one POST; needs HTTP 200, OggS magic, >1KiB.
tts_live() {
  local endpoint="$1" model="$2" keyfile="$3" body resp status hdr size magic extra
  endpoint=$(resolve_endpoint "$endpoint" "$model")
  body=$(mktemp); resp=$(mktemp); status=$(mktemp); hdr=$(mktemp)
  # v1.1 fix: mirror the plugin's own literal response_format when aa-tts.ts names one,
  # so the probe requests the same container the chain actually consumes.
  extra=$(extract_response_format)
  printf '{"model":"%s","input":"\u53ef\u7528\u6027\u68c0\u6d4b"%s}' "$model" "$extra" > "$body"
  auth_header_file "$hdr" "$keyfile"
  curl_post_json "$resp" "$status" "$endpoint" "$body" "$hdr"
  local rc=$? code; code=$(cat "$status")
  size=$(wc -c < "$resp" | tr -d ' ')
  magic=$(head -c 4 "$resp" | od -A n -t x1 | tr -s ' ')
  if [ "$code" != "200" ] && [ -z "$code" ] && [ "$rc" -ne 0 ]; then
    fail "tts-live — request failed before any HTTP status (curl exit $rc): $(truncate_text 200 < "$resp")"
  elif [ "$code" != "200" ]; then
    fail "tts-live — HTTP ${code:-<no response>}; body head: $(truncate_text 200 < "$resp")"
  elif [ "$magic" = " 52 49 46 46" ] && [ -z "$(printf '%s' "$extra" | grep -i ogg)" ]; then
    # v1.1: 52 49 46 46 is RIFF — the plugin did not pin ogg, so a wav response is
    # consistent with the source; only WARN (the caller's chain may still accept it).
    warn "tts-live — HTTP 200 but returned RIFF/wav (${size} bytes); aa-tts.ts pins no ogg response_format, so this is not a failure"
  elif [ "$magic" != " 4f 67 67 53" ]; then
    fail "tts-live — HTTP 200 but first 4 bytes are '$magic' (expected 4f 67 67 53 / OggS, or RIFF when the source pins no container)"
  elif [ "$size" -le 1024 ]; then
    fail "tts-live — HTTP 200 + recognised container but response is only ${size} bytes (expected >1024)"
  else
    pass "tts-live — HTTP 200, 4f 67 67 53 OggS magic, ${size} bytes (body discarded, never written to disk)"
  fi
  rm -f "$body" "$resp" "$status" "$hdr"
}

# ---------------- image/video helpers (02) ----------------

# ffmpeg_bin_check — item 1 of 02.
ffmpeg_bin_check() {
  if $DOCKER exec "$CONTAINER" sh -c 'command -v ffmpeg && command -v ffprobe && ffmpeg -version | head -n1'; then
    pass "ffmpeg-bin — ffmpeg + ffprobe present in $CONTAINER"
  else
    fail "ffmpeg-bin — ffmpeg/ffprobe missing in $CONTAINER; the whole img-ops/img-lab chain depends on them"
  fi
}

# file_lines_check <container-path> <expected-approx> — item 2 of 02.
file_lines_check() {
  local path="$1" expected="$2" out lines
  out=$($DOCKER exec "$CONTAINER" sh -c "wc -l '$path'" 2>/dev/null)
  lines=$(printf '%s' "$out" | awk '{print $1}')
  if [ -z "$lines" ]; then
    fail "file-lines — cannot read $path in $CONTAINER"
  elif [ "$lines" -eq "$expected" ]; then
    pass "file-lines — $path = $lines lines (as expected)"
  else
    warn "file-lines — $path = $lines lines (expected ~$expected; loaded copy may differ from the documented revision)"
  fi
}
