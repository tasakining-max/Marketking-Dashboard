#!/bin/bash
# คัต: the ONE allowed Whisper pass — transcribe a finished export once to confirm no word was clipped.
# usage: bash lib/reel/check.sh <export.mp4> ["initial prompt with names"]
exec /opt/homebrew/bin/uv run -q --with mlx-whisper python -I -c '
import sys, mlx_whisper
r = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo="mlx-community/whisper-large-v3-turbo", language="th", initial_prompt=(sys.argv[2] or None), condition_on_previous_text=False)
for s in r["segments"]: print(f"[{s[\"start\"]:.2f}-{s[\"end\"]:.2f}] {s[\"text\"].strip()}")
' "$1" "${2:-}" 2>/dev/null
