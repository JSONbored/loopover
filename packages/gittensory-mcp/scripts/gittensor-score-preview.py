#!/usr/bin/env python3
"""Reference local scorer for GITTENSOR_SCORE_PREVIEW_CMD.

Reads branch metadata JSON from stdin, reads changed files from repoRoot on disk,
and emits normalized score preview JSON to stdout. Requires a local entrius/gittensor checkout.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def is_test_file(path: str) -> bool:
    lowered = path.lower()
    basename = lowered.rsplit("/", 1)[-1]
    patterns = (
        "/test/",
        "/tests/",
        "/spec/",
        "/__tests__/",
        "/src/test/",
        "_test.go",
        "_test.py",
        "_test.rb",
        "_spec.rb",
        ".test.ts",
        ".test.tsx",
        ".test.js",
        ".test.jsx",
        ".test.py",
        ".test.rb",
        ".test.rs",
        ".spec.ts",
        ".spec.tsx",
        ".spec.js",
        ".spec.jsx",
        ".spec.py",
        ".spec.rb",
        ".spec.rs",
    )
    return any(token in lowered for token in patterns) or any(basename.endswith(suffix) for suffix in ("_test.go", "_test.py", "_test.rb"))


def load_gittensor(gittensor_root: str):
    root = Path(gittensor_root).resolve()
    if not root.exists():
        raise RuntimeError(f"GITTENSOR_ROOT does not exist: {root}")
    sys.path.insert(0, str(root))
    from gittensor.classes import FileChange
    from gittensor.utils.github_api_tools import FileContentPair
    from gittensor.validator.utils.load_weights import load_programming_languages, load_token_config
    from gittensor.validator.utils.tree_sitter_scoring import calculate_token_score_from_file_changes

    return FileChange, FileContentPair, load_programming_languages, load_token_config, calculate_token_score_from_file_changes


def score_with_gittensor(metadata: dict) -> dict:
    gittensor_root = metadata.get("gittensorRoot") or os.environ.get("GITTENSOR_ROOT")
    if not gittensor_root:
        raise RuntimeError("Set GITTENSOR_ROOT to a local entrius/gittensor checkout.")

    repo_root = Path(metadata.get("repoRoot") or os.getcwd()).resolve()
    (
        FileChange,
        FileContentPair,
        load_programming_languages,
        load_token_config,
        calculate_token_score_from_file_changes,
    ) = load_gittensor(gittensor_root)

    file_changes = []
    file_contents = {}
    source_lines = 0
    test_token_score = 0.0
    non_code_token_score = 0.0

    for entry in metadata.get("changedFiles") or []:
        path = str(entry.get("path") or "")
        if not path:
            continue
        additions = int(entry.get("additions") or 0)
        deletions = int(entry.get("deletions") or 0)
        status = str(entry.get("status") or "modified")
        file_changes.append(
            FileChange(
                pr_number=0,
                repository_full_name=str(metadata.get("repoFullName") or "local/repo"),
                filename=path,
                changes=max(additions + deletions, 0),
                additions=additions,
                deletions=deletions,
                status=status,
                previous_filename=entry.get("previousPath"),
            )
        )
        absolute = repo_root / path
        old_content = None
        new_content = None
        if status != "added" and absolute.exists():
            try:
                old_content = absolute.read_text(encoding="utf-8")
            except OSError:
                old_content = None
        if status != "removed":
            try:
                new_content = absolute.read_text(encoding="utf-8") if absolute.exists() else ""
            except OSError:
                new_content = None
        file_contents[path] = FileContentPair(old_content=old_content, new_content=new_content)
        if is_test_file(path):
            test_token_score += float(max(additions + deletions, 0))
        elif path.endswith((".md", ".txt", ".json", ".yaml", ".yml")):
            non_code_token_score += float(max(additions + deletions, 0))
        else:
            source_lines += max(additions + deletions, 0)

    weights = load_token_config()
    programming_languages = load_programming_languages()
    result = calculate_token_score_from_file_changes(file_changes, file_contents, weights, programming_languages)

    source_token_score = 0.0
    for file_result in result.file_results:
        if file_result.is_test_file:
            test_token_score = max(test_token_score, file_result.score)
        elif file_result.scoring_method == "line-count":
            non_code_token_score += file_result.score
        else:
            source_token_score += file_result.score

    total_token_score = float(result.total_score)
    if source_token_score <= 0 and total_token_score > 0:
        source_token_score = max(total_token_score - test_token_score - non_code_token_score, 0.0)

    return {
        "sourceTokenScore": round(source_token_score, 2),
        "totalTokenScore": round(total_token_score, 2),
        "sourceLines": int(result.total_lines or source_lines),
        "testTokenScore": round(test_token_score, 2),
        "nonCodeTokenScore": round(non_code_token_score, 2),
        "activeModel": "gittensor_tree_sitter_reference",
    }


def metadata_fallback(metadata: dict) -> dict:
    source = 0
    tests = 0
    non_code = 0
    for entry in metadata.get("changedFiles") or []:
        path = str(entry.get("path") or "")
        lines = max(int(entry.get("additions") or 0) + int(entry.get("deletions") or 0), 0)
        if is_test_file(path):
            tests += lines
        elif path.endswith((".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".rs", ".go", ".java", ".kt", ".scala", ".sql")):
            source += lines
        else:
            non_code += lines
    return {
        "sourceTokenScore": source,
        "totalTokenScore": source + tests + non_code,
        "sourceLines": source,
        "testTokenScore": tests,
        "nonCodeTokenScore": non_code,
        "warnings": ["Fell back to metadata line counts because gittensor scoring was unavailable."],
    }


def main() -> int:
    raw = sys.stdin.read()
    metadata = json.loads(raw) if raw.strip() else {}
    try:
        payload = score_with_gittensor(metadata)
    except Exception as error:
        payload = metadata_fallback(metadata)
        payload.setdefault("warnings", []).insert(0, str(error))
    sys.stdout.write(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
