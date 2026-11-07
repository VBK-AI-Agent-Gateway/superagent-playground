#!/usr/bin/env bash
# patch-scope.sh — VM prompt patch A2 (worker execution policy)
#
# Appends the fast-lane execution policy block to prompts/team/scope.md.
# Produces the file only; never restarts any service. Run --selftest first.
#
# Contract (per issue): backup -> idempotency -> patch -> post-write assertions;
# any assertion failure restores the backup and exits non-zero.
#
#   bash -n patch-scope.sh               # syntax only
#   ./patch-scope.sh --selftest          # full run against an inlined sample
#   ./patch-scope.sh                     # patch the live prompt file
#   ./patch-scope.sh --file PATH         # patch an alternative path
#
set -euo pipefail

TARGET_DEFAULT="/home/qt/src/dsh-sa-git/prompts/team/scope.md"
MARKER="[route:light]"

TARGET=""
SELFTEST=0

while [ $# -gt 0 ]; do
	case "$1" in
		--selftest) SELFTEST=1; shift ;;
		--file)
			[ $# -ge 2 ] || { echo "ERROR: --file needs a path" >&2; exit 2; }
			TARGET="$2"; shift 2 ;;
		-h|--help) sed -n '2,14p' "$0"; exit 0 ;;
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

	cat >> "$f" <<'EOF'

## Fast-lane tickets ([route:light])

- Tickets whose body carries [route:light]: execute as a single agent directly. Do not
  spawn subagents by default; spawn subagents only for parts that are both independent
  and large enough to benefit from parallelism — the subagent tools stay available for
  exactly that case. One self-check round (script checks first), then ship + PR.
- All other tickets: current policy unchanged.
EOF

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

	check "Tickets whose body carries [route:light]: execute as a single agent directly."
	check "Do not"
	check "spawn subagents by default"
	check "One self-check round (script checks first), then ship + PR."
	check "All other tickets: current policy unchanged."

	after_lines="$(wc -l < "$f")"
	if [ "$after_lines" -le "$before_lines" ]; then
		echo "ASSERT FAIL: file did not grow ($before_lines -> $after_lines)" >&2
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
		'# Worker scope' \
		'' \
		'You own the technical work in your ticket.' \
		'' \
		'## Parallelism' \
		'' \
		'Fan out subagents where parts are independent.' \
		> "$tmp/scope.md"

	echo "selftest: run 1 (patch + assert)"
	patch_file "$tmp/scope.md" || { echo "SELFTEST FAIL: run 1"; return 1; }

	baks="$(find "$tmp" -name 'scope.md.bak.route.*' | wc -l | tr -d ' ')"
	[ "$baks" -ge 1 ] || { echo "SELFTEST FAIL: no backup created"; return 1; }

	# Pre-existing content must survive untouched.
	grep -qF 'Fan out subagents where parts are independent.' "$tmp/scope.md" \
		|| { echo "SELFTEST FAIL: original content lost"; return 1; }

	echo "selftest: run 2 (idempotency must print SKIP)"
	set +e
	out2="$(patch_file "$tmp/scope.md" 2>&1)"
	rc=$?
	set -e
	[ "$rc" -eq 0 ] || { echo "SELFTEST FAIL: re-run exit $rc"; echo "$out2"; return 1; }
	printf '%s' "$out2" | grep -q '^SKIP:' || { echo "SELFTEST FAIL: re-run did not SKIP"; echo "$out2"; return 1; }
	[ "$(find "$tmp" -name 'scope.md.bak.route.*' | wc -l | tr -d ' ')" = "$baks" ] \
		|| { echo "SELFTEST FAIL: re-run created another backup"; return 1; }
	# The re-run must not duplicate the policy block.
	[ "$(grep -c '## Fast-lane tickets (\[route:light\])' "$tmp/scope.md")" = 1 ] \
		|| { echo "SELFTEST FAIL: policy block duplicated on re-run"; return 1; }

	echo "selftest: run 3 (write failure must roll back)"
	# A read-only file makes the append fail after the backup was taken; the
	# rollback path must leave the original content byte-identical.
	printf '%s\n' '# scope' 'existing rule' > "$tmp/ro.md"
	cp -p "$tmp/ro.md" "$tmp/ro.md.orig"
	chmod 400 "$tmp/ro.md"
	probe_failed=0
	set +e
	patch_file "$tmp/ro.md" >/dev/null 2>&1
	rc=$?
	set -e
	chmod 600 "$tmp/ro.md"
	if [ "$rc" -ne 0 ]; then
		probe_failed=1
		cmp -s "$tmp/ro.md" "$tmp/ro.md.orig" || { echo "SELFTEST FAIL: failed write left the file changed"; return 1; }
	fi
	[ "$probe_failed" -eq 1 ] || { echo "SELFTEST FAIL: unwritable target did not fail (running as root?)"; return 1; }

	echo "selftest: run 4 (pre-marked file must SKIP)"
	{ echo '# x'; echo 'carries [route:light]'; } > "$tmp/marked.md"
	cp -p "$tmp/marked.md" "$tmp/marked.md.orig"
	set +e
	out4="$(patch_file "$tmp/marked.md" 2>&1)"
	rc=$?
	set -e
	[ "$rc" -eq 0 ] || { echo "SELFTEST FAIL: pre-marked exit $rc"; return 1; }
	printf '%s' "$out4" | grep -q '^SKIP:' || { echo "SELFTEST FAIL: pre-marked did not SKIP"; return 1; }
	cmp -s "$tmp/marked.md" "$tmp/marked.md.orig" || { echo "SELFTEST FAIL: pre-marked file was modified"; return 1; }

	echo "selftest: run 5 (missing target must fail)"
	set +e
	patch_file "$tmp/does-not-exist.md" >/dev/null 2>&1
	rc=$?
	set -e
	[ "$rc" -ne 0 ] || { echo "SELFTEST FAIL: missing target exited 0"; return 1; }

	echo "SELFTEST_OK"
	rm -rf "$tmp"
}

if [ "$SELFTEST" -eq 1 ]; then
	selftest
else
	patch_file "${TARGET:-$TARGET_DEFAULT}"
fi
