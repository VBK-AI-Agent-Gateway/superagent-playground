#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""patch-skillguide.py —— EU 侧 skillGuide 规则注入补丁（B2）

目标：宿主 /srv/wagate/personal-assistant.ts
做法：先 grep 定位 skillGuide 注入文本的字符串常量，再在该常量内追加「分诊路由」
      规则段，最后做写后断言与 md5 输出。

铁律：备份 → 幂等 → 写后断言 → 失败自动回滚并退出非 0。
本脚本由操作员在 EU 宿主执行；worker 不执行任何一步。
"""

import argparse
import hashlib
import os
import re
import shutil
import sys
import time

TARGET_DEFAULT = "/srv/wagate/personal-assistant.ts"
MARKER = "dispatch_dev"  # 幂等标记：已出现即 SKIP

RULES = """
【分诊路由 · 开发类需求】
- 完整系统 / app / 多模块开发 → 必须调用 dispatch_dev（附 context=近期对话摘要），禁止本地自建。
- 派单后立即停止本地开发，把工单链接转达给用户，等工单结果回传。
- 文件 / 数据 / 文档 / 看板 / 问答 / 单页 / 小改 → 本地正常做。
- 判断不了 → 先本地做；过程中发现规模超出单页可承载 → 调 dispatch_dev 转工单并告知用户。
- 用户接受「本地简版」兜底时：仍只允许单页 / 文档级交付，禁止多模块自建；
  一旦超出该边界，再次提示转工单。
"""


def md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def find_injection_point(src: str):
    """定位 skillGuide 注入文本的字符串常量。

    返回 (start, end, quote, line_no) —— 待插入字符串在文件中的字符区间。
    策略：先找 skillGuide 标识符，再从其后找第一个模板串/普通串常量。
    """
    m = re.search(r"skillGuide", src)
    if not m:
        return None
    # 在 skillGuide 之后寻找字符串常量起始（模板串 ` 或 " 或 '）
    for sm in re.finditer(r"(`|\"|')", src[m.end():]):
        start = m.end() + sm.start()
        quote = sm.group(1)
        # 找同名未转义的收尾引号
        i = start + 1
        while i < len(src):
            c = src[i]
            if c == "\\":
                i += 2
                continue
            if c == quote and (quote != "`" or src[i - 1] != "\\"):
                end = i
                line_no = src.count("\n", 0, start) + 1
                return (start, end, quote, line_no)
            i += 1
        # 未闭合：继续找下一个
    return None


def patch_file(path: str, apply: bool) -> int:
    if not os.path.isfile(path):
        print(f"ERROR: target not found: {path}", file=sys.stderr)
        return 1

    with open(path, "r", encoding="utf-8") as f:
        src = f.read()

    if MARKER in src:
        print(f"SKIP: {path} already contains '{MARKER}' (idempotent)")
        return 0

    point = find_injection_point(src)
    if not point:
        print(
            f"ERROR: could not locate a skillGuide string constant in {path}; "
            "请人工确认该文件的 skillGuide 注入位置。",
            file=sys.stderr,
        )
        return 1
    start, end, quote, line_no = point

    # 在字符串常量内部末尾插入规则（保持原引号类型；规则里不含该引号）
    if quote in RULES:
        print(f"ERROR: rules text contains the string delimiter {quote!r}", file=sys.stderr)
        return 1

    before_lines = src.count("\n") + 1
    new_src = src[:end] + RULES + src[end:]

    print(f"insertion point: line {line_no} (string const with {quote!r})")
    print(f"before: {before_lines} lines, {len(src)} chars")
    print(f"after : {new_src.count(chr(10)) + 1} lines, {len(new_src)} chars")

    if not apply:
        print("DRY-RUN: 未写入（加 --apply 才落盘）")
        return 0

    ts = int(time.time())
    backup = f"{path}.bak.route.{ts}"
    shutil.copy2(path, backup)
    print(f"backup: {backup}")
    print(f"md5(before): {md5(path)}")

    rollback_needed = False
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_src)
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: write failed: {e}", file=sys.stderr)
        rollback_needed = True

    if not rollback_needed:
        # 写后断言（非致命累积，最后统一判定）
        with open(path, "r", encoding="utf-8") as f:
            written = f.read()
        asserted = 0
        ok = 1

        def check(cond, what):
            nonlocal asserted, ok
            asserted += 1
            if not cond:
                ok = 0
                print(f"ASSERT FAIL: {what}", file=sys.stderr)

        for probe in (
            "dispatch_dev",
            "禁止本地自建",
            "等工单结果回传",
            "单页 / 文档级交付",
        ):
            check(probe in written, f"missing expected content: {probe}")
        check(
            written.count("\n") + 1 > before_lines,
            "file did not grow after patch",
        )
        check(written.startswith(src[: start]), "content before insertion point changed")
        check(written.endswith(src[end:]), "content after insertion point changed")

        if ok != 1:
            rollback_needed = True
        else:
            print(f"assertions: {asserted} checks OK")
            print(f"md5(after):  {md5(path)}")
            print(f"OK: {path} patched")

    if rollback_needed:
        try:
            shutil.copy2(backup, path)
            print(f"ROLLBACK: restored {path} from {backup}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"ROLLBACK FAILED: {e}", file=sys.stderr)
        return 1
    return 0


def selftest() -> int:
    import tempfile

    tmp = tempfile.mkdtemp(prefix="skillguide-selftest.")
    rc_all = 0
    try:
        # --- run 1: 正常补丁 + 断言 ---
        print("selftest: run 1 (patch + assert)")
        t = os.path.join(tmp, "pa.ts")
        with open(t, "w", encoding="utf-8") as f:
            f.write(
                "const skillGuide = `\n"
                "你是个人助理。\n"
                "`;\n"
                "export default skillGuide;\n"
            )
        orig = open(t, encoding="utf-8").read()
        rc = patch_file(t, True)
        body = open(t, encoding="utf-8").read()
        if rc != 0 or "dispatch_dev" not in body:
            print(f"SELFTEST FAIL: run 1 rc={rc}", file=sys.stderr)
            rc_all = 1
        elif not any(n.startswith(os.path.basename(t) + ".bak.route.") for n in os.listdir(tmp)):
            print("SELFTEST FAIL: run 1 no backup created", file=sys.stderr)
            rc_all = 1

        # --- run 2: 幂等 ---
        print("selftest: run 2 (idempotent SKIP)")
        n_bak = len([n for n in os.listdir(tmp) if ".bak.route." in n])
        rc2 = patch_file(t, True)
        n_bak2 = len([n for n in os.listdir(tmp) if ".bak.route." in n])
        if rc2 != 0 or n_bak2 != n_bak or open(t, encoding="utf-8").read() != body:
            print("SELFTEST FAIL: run 2 not idempotent", file=sys.stderr)
            rc_all = 1

        # --- run 3: 找不到 skillGuide 必须失败 ---
        print("selftest: run 3 (no skillGuide must fail)")
        t3 = os.path.join(tmp, "nosg.ts")
        with open(t3, "w", encoding="utf-8") as f:
            f.write("const other = `nothing here`;\n")
        orig3 = open(t3, encoding="utf-8").read()
        rc3 = patch_file(t3, True)
        if rc3 == 0 or open(t3, encoding="utf-8").read() != orig3:
            print("SELFTEST FAIL: run 3 should fail and leave file untouched", file=sys.stderr)
            rc_all = 1

        # --- run 4: 目标缺失必须失败 ---
        print("selftest: run 4 (missing target must fail)")
        rc4 = patch_file(os.path.join(tmp, "does-not-exist.ts"), True)
        if rc4 == 0:
            print("SELFTEST FAIL: run 4 missing target exited 0", file=sys.stderr)
            rc_all = 1

        # --- run 5: dry-run 不落盘 ---
        print("selftest: run 5 (dry-run must not write)")
        t5 = os.path.join(tmp, "dry.ts")
        with open(t5, "w", encoding="utf-8") as f:
            f.write("const skillGuide = `hi`;\n")
        o5 = open(t5, encoding="utf-8").read()
        rc5 = patch_file(t5, False)
        if rc5 != 0 or open(t5, encoding="utf-8").read() != o5:
            print("SELFTEST FAIL: run 5 dry-run wrote the file", file=sys.stderr)
            rc_all = 1

        # --- run 6: 预标记文件必须 SKIP 且字节不变 ---
        print("selftest: run 6 (pre-marked must SKIP unchanged)")
        t6 = os.path.join(tmp, "marked.ts")
        with open(t6, "w", encoding="utf-8") as f:
            f.write("const skillGuide = `already has dispatch_dev`;\n")
        o6 = open(t6, "rb").read()
        rc6 = patch_file(t6, True)
        if rc6 != 0 or open(t6, "rb").read() != o6:
            print("SELFTEST FAIL: run 6 pre-marked file changed", file=sys.stderr)
            rc_all = 1

        if rc_all == 0:
            print("SELFTEST_OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return rc_all


def main() -> int:
    ap = argparse.ArgumentParser(
        description="修补 EU 宿主 personal-assistant.ts 的 skillGuide 分诊路由规则",
    )
    ap.add_argument("--selftest", action="store_true", help="在临时目录自检，不触碰真实目标")
    ap.add_argument("--file", default=TARGET_DEFAULT, help=f"目标文件（默认 {TARGET_DEFAULT}）")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认 dry-run）")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    return patch_file(args.file, args.apply)


if __name__ == "__main__":
    sys.exit(main())
