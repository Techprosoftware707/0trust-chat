#!/usr/bin/env python3
"""Verdict and JUnit XML from `adb shell am instrument -w -r` output (AndroidJUnitRunner).

    python3 instrumentation.py RAW_OUTPUT --junit OUT.xml [--expect N]

`am instrument` exits 0 whether tests pass or not, so its raw status stream is parsed here.
Exit status 0 only if at least --expect tests ran and every one passed (a skipped test, i.e. an
assumption failure because an argument was missing, counts as a failure here) and the run
finished normally. Prints one line per test.
"""
from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET

# AndroidJUnitRunner status codes (androidx.test.internal.runner.listener.InstrumentationResultPrinter)
START, OK, ERROR, FAILURE, IGNORED, ASSUMPTION = 1, 0, -1, -2, -3, -4
NAMES = {OK: "passed", ERROR: "error", FAILURE: "failed", IGNORED: "ignored", ASSUMPTION: "skipped (assumption failed)"}


def parse(text: str):
    results: dict[str, tuple[int, str]] = {}
    order: list[str] = []
    cur: dict[str, str] = {}
    key = None
    finished = False
    result_lines: list[str] = []
    in_result = False
    for line in text.splitlines():
        if line.startswith("INSTRUMENTATION_STATUS: "):
            k, _, v = line[len("INSTRUMENTATION_STATUS: "):].partition("=")
            cur[k] = v
            key = k
            in_result = False
        elif line.startswith("INSTRUMENTATION_STATUS_CODE: "):
            code = int(line.split(":", 1)[1].strip())
            name = f"{cur.get('class', '?')}#{cur.get('test', '?')}"
            if code == START:
                if name not in order:
                    order.append(name)
            else:
                results[name] = (code, cur.get("stack", ""))
            cur, key = {}, None
        elif line.startswith("INSTRUMENTATION_RESULT: "):
            in_result = True
            key = None
            result_lines.append(line)
        elif line.startswith("INSTRUMENTATION_CODE: "):
            finished = line.split(":", 1)[1].strip() == "-1"
            in_result = False
        elif in_result:
            result_lines.append(line)
        elif key is not None:
            cur[key] = cur.get(key, "") + "\n" + line
    for name in order:
        results.setdefault(name, (ERROR, "test started but never finished (process crash?)"))
    return order, results, finished, "\n".join(result_lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("raw")
    ap.add_argument("--junit")
    ap.add_argument("--expect", type=int, default=1)
    a = ap.parse_args()
    text = open(a.raw, encoding="utf-8", errors="replace").read()
    order, results, finished, result = parse(text)
    ok = finished and len(order) >= a.expect and all(results[n][0] == OK for n in order)
    for n in order:
        code, stack = results[n]
        print(f"{'PASS' if code == OK else 'FAIL'} {n}: {NAMES.get(code, code)}")
        if code != OK and stack:
            print("     " + "\n     ".join(stack.strip().splitlines()[:12]))
    if not finished:
        print("FAIL instrumentation did not finish normally:\n     " + "\n     ".join((result or text[-2000:]).splitlines()[-15:]))
    if a.junit:
        suite = ET.Element("testsuite", name="ServerE2eTest", tests=str(len(order)),
                           failures=str(sum(1 for n in order if results[n][0] != OK)))
        for n in order:
            cls, _, test = n.partition("#")
            case = ET.SubElement(suite, "testcase", classname=cls, name=test)
            code, stack = results[n]
            if code in (IGNORED, ASSUMPTION):
                ET.SubElement(case, "skipped", message=NAMES[code]).text = stack
            elif code != OK:
                ET.SubElement(case, "failure", message=NAMES.get(code, str(code))).text = stack
        ET.ElementTree(suite).write(a.junit, encoding="utf-8", xml_declaration=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
