#!/usr/bin/env python3
"""Generate CEFR word levels from Oxford 3000/5000 PDFs.

This parser reads text drawing operations directly from PDF content streams,
extracts headwords, then emits a JS map for extension runtime lookup.
"""

from __future__ import annotations

import argparse
import re
import zlib
from collections import defaultdict
from pathlib import Path

LEVEL_ORDER = {"A1": 1, "A2": 2, "B1": 3, "B2": 4, "C1": 5, "C2": 6}
LEVEL_VALUES = set(LEVEL_ORDER.keys())

WORD_LINE_RE = re.compile(
    r"^([A-Za-z][A-Za-z'’.-]*(?:\s+[A-Za-z][A-Za-z'’.-]*)*)"
    r"(?:\s*\([^)]*\))?\s+"
    r"(?:n\.|v\.|adj\.|adv\.|prep\.|pron\.|det\.|conj\.|exclam\.|"
    r"modal\s+v\.|auxiliary\s+v\.|det\./pron\.|pron\./det\.|"
    r"n\./adj\.|adj\./adv\.|adj\./n\.|prep\./adv\.|adv\./prep\.|"
    r"n\./v\.|v\./n\.)"
)

# Ligatures in these PDFs are embedded as control chars depending on font maps.
# We produce repaired variants for entries that contain a space because of a
# dropped ligature glyph (e.g. "di cult" -> "difficult").
SPACE_REPAIR_INSERTS = ["", "f", "ff", "fi", "ffi", "fl"]
SPACE_REPAIR_SKIP_SUFFIXES = {"to", "one", "more", "right", "cream", "cent"}
SPACE_REPAIR_FORCE = {
    "o clock": "o'clock",
}


def parse_objects(data: bytes) -> dict[int, bytes]:
    return {int(m.group(1)): m.group(3) for m in re.finditer(rb"(\d+)\s+(\d+)\s+obj(.*?)endobj", data, re.S)}


def parse_pdf_string(data: bytes, idx: int) -> tuple[str, int]:
    idx += 1  # skip '('
    depth = 1
    out = bytearray()

    while idx < len(data) and depth > 0:
        c = data[idx]
        if c == 92:  # backslash
            idx += 1
            if idx >= len(data):
                break
            c2 = data[idx]
            if c2 in b"nrtbf":
                out.append({ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("b"): 8, ord("f"): 12}[c2])
            elif c2 in b"()\\":
                out.append(c2)
            elif 48 <= c2 <= 55:
                octal = bytes([c2])
                j = 0
                while j < 2 and idx + 1 < len(data) and 48 <= data[idx + 1] <= 55:
                    idx += 1
                    octal += bytes([data[idx]])
                    j += 1
                out.append(int(octal, 8))
            else:
                out.append(c2)
        elif c == 40:  # (
            depth += 1
            out.append(c)
        elif c == 41:  # )
            depth -= 1
            if depth > 0:
                out.append(c)
        else:
            out.append(c)
        idx += 1

    return out.decode("latin-1", "ignore"), idx


def parse_array(data: bytes, idx: int):
    idx += 1  # skip '['
    arr = []
    while idx < len(data):
        c = data[idx]
        if c in b" \t\r\n\f\x00":
            idx += 1
            continue
        if c == 93:  # ]
            idx += 1
            break
        if c == 40:  # (
            s, idx = parse_pdf_string(data, idx)
            arr.append(("str", s))
            continue
        j = idx
        while j < len(data) and data[j] not in b" \t\r\n\f\x00[]()":
            j += 1
        arr.append(("tok", data[idx:j].decode("latin-1", "ignore")))
        idx = j
    return arr, idx


def tokenize(stream: bytes):
    idx = 0
    while idx < len(stream):
        c = stream[idx]
        if c in b" \t\r\n\f\x00":
            idx += 1
            continue
        if c == 37:  # comment
            while idx < len(stream) and stream[idx] not in b"\r\n":
                idx += 1
            continue
        if c == 40:  # (
            s, idx = parse_pdf_string(stream, idx)
            yield ("str", s)
            continue
        if c == 91:  # [
            arr, idx = parse_array(stream, idx)
            yield ("arr", arr)
            continue
        j = idx
        while j < len(stream) and stream[j] not in b" \t\r\n\f\x00[]()":
            j += 1
        yield ("tok", stream[idx:j].decode("latin-1", "ignore"))
        idx = j


def stream_to_lines(stream: bytes) -> list[str]:
    lines: list[str] = []
    line = ""
    stack: list[tuple[str, object]] = []

    def flush() -> None:
        nonlocal line
        safe = "".join(ch if 32 <= ord(ch) <= 126 else " " for ch in line)
        safe = re.sub(r"\s+", " ", safe).strip()
        if safe:
            lines.append(safe)
        line = ""

    for kind, value in tokenize(stream):
        if kind == "tok" and value in {"Tm", "Td", "TD", "T*"}:
            flush()
            stack = []
            continue
        if kind == "tok" and value in {"BT", "ET"}:
            if value == "ET":
                flush()
            stack = []
            continue
        if kind == "tok" and value == "Tj":
            if stack and stack[-1][0] == "str":
                line += str(stack[-1][1])
            stack = []
            continue
        if kind == "tok" and value == "TJ":
            if stack and stack[-1][0] == "arr":
                arr = stack[-1][1]
                line += "".join(item[1] for item in arr if item[0] == "str")
            stack = []
            continue
        stack.append((kind, value))

    flush()
    return lines


def extract_lines_from_pdf(path: Path) -> list[str]:
    data = path.read_bytes()
    objects = parse_objects(data)
    pages = []

    for obj_no, body in objects.items():
        if not re.search(rb"/Type\s*/Page(?!s)\b", body):
            continue

        refs: list[int] = []
        m_array = re.search(rb"/Contents\s*\[(.*?)\]", body, re.S)
        if m_array:
            refs = [int(x) for x in re.findall(rb"(\d+)\s+0\s+R", m_array.group(1))]
        else:
            m_single = re.search(rb"/Contents\s+(\d+)\s+0\s+R", body)
            if m_single:
                refs = [int(m_single.group(1))]

        page_lines: list[str] = []
        for ref in refs:
            content_obj = objects.get(ref, b"")
            if b"stream" not in content_obj:
                continue
            header, rest = content_obj.split(b"stream", 1)
            stream, _tail = rest.split(b"endstream", 1)
            stream = stream.lstrip(b"\r\n").rstrip(b"\r\n")
            if b"/FlateDecode" in header:
                try:
                    stream = zlib.decompress(stream)
                except zlib.error:
                    continue
            page_lines.extend(stream_to_lines(stream))

        page_num = 999
        for line in page_lines[:6]:
            m = re.match(r"^(\d+)\s*/\s*(\d+)$", line)
            if m:
                page_num = int(m.group(1))
                break

        pages.append((page_num, obj_no, page_lines))

    pages.sort(key=lambda item: (item[0], item[1]))

    lines: list[str] = []
    for _page_num, _obj_no, page_lines in pages:
        lines.extend(page_lines)
    return lines


def normalize_headword(raw: str) -> str:
    return raw.lower().replace("’", "'").strip(" .,-;:!?[]{}\"'")


def maybe_repair_spaced_word(word: str, dictionary_words: set[str]) -> set[str]:
    if " " not in word:
        return {word}

    forced = SPACE_REPAIR_FORCE.get(word)
    if forced:
        return {forced}

    parts = [part for part in word.split(" ") if part]
    if len(parts) != 2:
        # Most true multi-word entries are not useful for token lookup.
        return set()

    left, right = parts
    if not (left.isalpha() and right.isalpha()):
        return set()
    if right in SPACE_REPAIR_SKIP_SUFFIXES:
        return set()

    variants = set()
    for insert in SPACE_REPAIR_INSERTS:
        candidate = f"{left}{insert}{right}"
        if re.fullmatch(r"[a-z]+(?:-[a-z]+)?(?:'[a-z]+)?", candidate):
            if candidate in dictionary_words:
                variants.add(candidate)

    return variants


def build_word_levels(lines: list[str], dictionary_words: set[str]) -> dict[str, str]:
    levels: dict[str, set[str]] = defaultdict(set)
    current_level = ""

    for line in lines:
        if line in LEVEL_VALUES:
            current_level = line
            continue
        if not current_level:
            continue

        match = WORD_LINE_RE.match(line)
        if not match:
            continue

        base_word = normalize_headword(match.group(1))
        if base_word.endswith(" modal"):
            base_word = base_word[: -len(" modal")].strip()
        if base_word.endswith(" auxiliary"):
            base_word = base_word[: -len(" auxiliary")].strip()
        if not base_word:
            continue

        candidates = set()
        if re.fullmatch(r"[a-z]+(?:-[a-z]+)?(?:'[a-z]+)?", base_word):
            candidates.add(base_word)
        candidates.update(maybe_repair_spaced_word(base_word, dictionary_words))

        for candidate in candidates:
            levels[candidate].add(current_level)

    # Resolve words with multiple CEFR labels by choosing the easiest level.
    resolved: dict[str, str] = {}
    for word, word_levels in levels.items():
        resolved[word] = min(word_levels, key=lambda lvl: LEVEL_ORDER.get(lvl, 99))

    return dict(sorted(resolved.items()))


def write_js_map(output_path: Path, word_levels: dict[str, str]) -> None:
    with output_path.open("w", encoding="utf-8") as f:
        f.write("// Generated from The_Oxford_3000_by_CEFR_level.pdf and The_Oxford_5000_by_CEFR_level.pdf\n")
        f.write("// Do not edit manually. Run scripts/generate_cefr_from_oxford.py to refresh.\n\n")
        f.write("export const CEFR_WORD_LEVEL_MAP = Object.freeze({\n")
        for word, level in word_levels.items():
            f.write(f"  \"{word}\": \"{level}\",\n")
        f.write("});\n\n")
        f.write("export const CEFR_WORDS = Object.freeze(Object.keys(CEFR_WORD_LEVEL_MAP));\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--oxford3000", required=True)
    parser.add_argument("--oxford5000", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    dictionary_path = Path("/usr/share/dict/words")
    dictionary_words = set()
    if dictionary_path.exists():
        dictionary_words = {line.strip().lower() for line in dictionary_path.read_text(encoding="utf-8", errors="ignore").splitlines()}

    lines = extract_lines_from_pdf(Path(args.oxford3000)) + extract_lines_from_pdf(Path(args.oxford5000))
    word_levels = build_word_levels(lines, dictionary_words)
    write_js_map(Path(args.output), word_levels)

    counts = defaultdict(int)
    for lvl in word_levels.values():
        counts[lvl] += 1
    total = len(word_levels)
    summary = ", ".join(f"{lvl}:{counts[lvl]}" for lvl in ["A1", "A2", "B1", "B2", "C1", "C2"] if counts[lvl])
    print(f"Wrote {total} words -> {args.output}")
    print(summary)


if __name__ == "__main__":
    main()
