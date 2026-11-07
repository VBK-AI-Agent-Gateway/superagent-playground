#!/usr/bin/env bash
# patch-admission.sh — VM prompt patch A1 (admission rules)
#
# Generalizes the automation-account sentence on line 14 of prompts/admission.md
# and appends three routing rules. Produces the file only; never restarts any
# service. The operator runs --selftest first, then the real run.
#
# Contract (per issue): backup -> idempotency -> patch -> post-write assertions;
# any assertion failure restores the backup and exits non-zero.
#
#   bash -n patch-admission.sh           # syntax only
#   ./patch-admission.sh --selftest      # full run against an inlined sample
#   ./patch-admission.sh                 # patch the live prompt file
#   ./patch-admission.sh --file PATH     # patch an alternative path
#
set -euo pipefail

TARGET_DEFAULT="/home/qt/src/dsh-sa-git/prompts/admission.md"
MARKER="sandbox-dispatch[bot]"
OLD_TEXT="(github-actions[bot])"
NEW_TEXT="(a bot in the policy bots list, currently github-actions[bot] or sandbox-dispatch[bot])"

TARGET=""
SELFTEST=0

while [ $# -gt 0 ]; do
	case "$1" in
		--selftest) SELFTEST=1; shift ;;
		--file)
			[ $# -ge 2 ] || { echo "ERROR: --file needs a path" >&2; exit 2; }
			TARGET="$2"; shift 2 ;;
		-h|--help) sed -n '2,16p' "$0"; exit 0 ;;
		*) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
	esac
done

# ---------------------------------------------------------------------------
# patch <file>: backup -> idempotency check -> edit -> assertions
# ---------------------------------------------------------------------------
patch_file() {
	local f="$1" ts bak
	if [ ! -f "$f" ]; then
		echo "ERROR: target not found: $f" >&2
		return 1
	fi

	if grep -qF "$MARKER" "$f"; then
		echo "SKIP: $f already contains '$MARKER' (idempotent, nothing to do)"
		return 0
	fi

	ts="$(date +%s)"
	bak="$f.bak.route.$ts"
	cp -p "$f" "$bak"
	echo "backup: $bak"

	local before_lines after_lines
	before_lines="$(wc -l < "$f")"

	# Restore-on-failure helper: every failure path below rolls back. It is
	# called explicitly instead of through an ERR trap so that rollback also
	# happens when the caller runs the script with `set +e`.
	rollback() {
		local rc=$?
		if [ -f "$bak" ]; then
			cp -p "$bak" "$f"
			echo "ROLLBACK: restored $f from $bak" >&2
		fi
		return $rc
	}

	if ! python3 - "$f" "$OLD_TEXT" "$NEW_TEXT" <<'PY'
import sys

path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "r", encoding="utf-8") as fh:
    lines = fh.readlines()

hits = [i for i, ln in enumerate(lines) if old in ln]
if len(hits) != 1:
    sys.stderr.write(
        "ERROR: expected exactly 1 line containing %r, found %d\n" % (old, len(hits))
    )
    sys.exit(1)
line_no = hits[0] + 1
if line_no != 14:
    sys.stderr.write(
        "WARNING: anchor moved to line %d (expected 14); patching it anyway\n" % line_no
    )
lines[hits[0]] = lines[hits[0]].replace(old, new)

lines.append("\n")
lines.append(
    "- A ticket body carrying [route:light] with a complete written specification: "
    "accept in one pass — load the candidate window once, read at most the specification "
    "and one further page, then call orchestrator_eval_decide; do not expand context "
    "further for work that is explicitly authorized and in scope.\n"
)
lines.append(
    "- A ticket body containing \"来源: sandbox-dispatch\" (planner-dispatched): judge "
    "against the fixed-template specification sections it carries "
    "(目标/范围/交付物形态/验收标准/技术约束/非目标) under the current "
    "full-specification rules.\n"
)
lines.append("- Everything else: current rules; when uncertain, treat as heavy.\n")

with open(path, "w", encoding="utf-8") as fh:
    fh.writelines(lines)
print("patched: line %d generalized, 3 rules appended" % line_no)
PY
	then
		echo "PATCH FAIL: could not apply the anchor edit" >&2
		rollback
		return 1
	fi

	# ---- post-write assertions -------------------------------------------
	# Runs on every exit path, including when the caller disabled `set -e`.
	local asserted=0 ok=1
	check() {
		if ! grep -qF -- "$1" "$f"; then
			echo "ASSERT FAIL: missing expected content: $1" >&2
			ok=0
			return 0
		fi
		asserted=$((asserted + 1))
	}

	check "$NEW_TEXT"
	check "[route:light] with a complete written specification"
	check "来源: sandbox-dispatch"
	check "when uncertain, treat as heavy"

	after_lines="$(wc -l < "$f")"
	if [ "$after_lines" -lt $((before_lines + 3)) ]; then
		echo "ASSERT FAIL: line count did not grow by >=3 ($before_lines -> $after_lines)" >&2
		ok=0
	fi

	# The patch must actually be new content, never a re-run of the same edit.
	if grep -qF "$OLD_TEXT" "$f"; then
		echo "ASSERT FAIL: old text $OLD_TEXT still present" >&2
		ok=0
	fi

	if [ "$ok" -ne 1 ]; then
		rollback
		return 1
	fi

	echo "assertions: $asserted greps OK, lines $before_lines -> $after_lines"
	echo "OK: $f patched"
	return 0
}

# ---------------------------------------------------------------------------
# self test: same code path against an inlined sample in a temp dir
# ---------------------------------------------------------------------------
selftest() {
	local tmp rc out2 out4 baks
	tmp="$(mktemp -d)"
	printf '%s\n' \
		'# Admission' \
		'' \
		'Rules for judging incoming content.' \
		'' \
		'1. First rule.' \
		'2. Second rule.' \
		'3. Third rule.' \
		'4. Fourth rule.' \
		'5. Fifth rule.' \
		'6. Sixth rule.' \
		'7. Seventh rule.' \
		'8. Eighth rule.' \
		'' \
		'A message relayed by the operator'"'"'s automation account (github-actions[bot]) carries the operator'"'"'s authority: judge its content on its merits against the enabled rules, the same as a person'"'"'s message.' \
		'' \
		'9. Ninth rule.' \
		> "$tmp/admission.md"

	echo "selftest: run 1 (patch + assert)"
	patch_file "$tmp/admission.md" || { echo "SELFTEST FAIL: run 1"; return 1; }

	baks="$(find "$tmp" -name 'admission.md.bak.route.*' | wc -l | tr -d ' ')"
	[ "$baks" -ge 1 ] || { echo "SELFTEST FAIL: no backup created"; return 1; }

	# The generalized sentence keeps the rest of the line verbatim.
	grep -qF "carries the operator's authority: judge its content on its merits against the enabled rules, the same as a person's message." "$tmp/admission.md" \
		|| { echo "SELFTEST FAIL: sentence tail not preserved verbatim"; return 1; }
	# Untouched lines survive.
	grep -qF '9. Ninth rule.' "$tmp/admission.md" \
		|| { echo "SELFTEST FAIL: unrelated content lost"; return 1; }

	echo "selftest: run 2 (idempotency must print SKIP)"
	set +e
	out2="$(patch_file "$tmp/admission.md" 2>&1)"
	rc=$?
	set -e
	[ "$rc" -eq 0 ] || { echo "SELFTEST FAIL: re-run exit $rc"; echo "$out2"; return 1; }
	printf '%s' "$out2" | grep -q '^SKIP:' || { echo "SELFTEST FAIL: re-run did not SKIP"; echo "$out2"; return 1; }
	[ "$(find "$tmp" -name 'admission.md.bak.route.*' | wc -l | tr -d ' ')" = "$baks" ] \
		|| { echo "SELFTEST FAIL: re-run created another backup"; return 1; }

	echo "selftest: run 3 (missing anchor must fail and restore)"
	printf 'no anchor here\n' > "$tmp/bad.md"
	cp -p "$tmp/bad.md" "$tmp/bad.md.orig"
	set +e
	patch_file "$tmp/bad.md" >/dev/null 2>&1
	rc=$?
	set -e
	[ "$rc" -ne 0 ] || { echo "SELFTEST FAIL: bad input exited 0"; return 1; }
	cmp -s "$tmp/bad.md" "$tmp/bad.md.orig" || { echo "SELFTEST FAIL: bad input left the file changed"; return 1; }

	echo "selftest: run 4 (pre-marked file must SKIP)"
	{ echo '# x'; echo 'sandbox-dispatch[bot]'; } > "$tmp/marked.md"
	cp -p "$tmp/marked.md" "$tmp/marked.md.orig"
	set +e
	out4="$(patch_file "$tmp/marked.md" 2>&1)"
	rc=$?
	set -e
	[ "$rc" -eq 0 ] || { echo "SELFTEST FAIL: pre-marked exit $rc"; return 1; }
	printf '%s' "$out4" | grep -q '^SKIP:' || { echo "SELFTEST FAIL: pre-marked did not SKIP"; return 1; }
	cmp -s "$tmp/marked.md" "$tmp/marked.md.orig" || { echo "SELFTEST FAIL: pre-marked file was modified"; return 1; }

	echo "selftest: run 5 (anchor present twice must fail and restore)"
	printf '(github-actions[bot]) one\n(github-actions[bot]) two\n' > "$tmp/dup.md"
	cp -p "$tmp/dup.md" "$tmp/dup.md.orig"
	set +e
	patch_file "$tmp/dup.md" >/dev/null 2>&1
	rc=$?
	set -e
	[ "$rc" -ne 0 ] || { echo "SELFTEST FAIL: ambiguous anchor exited 0"; return 1; }
	cmp -s "$tmp/dup.md" "$tmp/dup.md.orig" || { echo "SELFTEST FAIL: ambiguous anchor left the file changed"; return 1; }

	echo "SELFTEST_OK"
	rm -rf "$tmp"
}

if [ "$SELFTEST" -eq 1 ]; then
	selftest
else
	patch_file "${TARGET:-$TARGET_DEFAULT}"
fi
