#!/bin/sh
# test-vim-syntax.sh — Verify zelto-slice Vim syntax file loads without errors
#
# This script checks that syntax/zelto-slice.vim is valid Vim syntax.
# If vim is not installed, it skips gracefully (exit 0).
#
# Usage: scripts/test-vim-syntax.sh
# Run from project root.

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNTAX_FILE="$PROJECT_ROOT/syntax/zelto-slice.vim"
FTDETECT_FILE="$PROJECT_ROOT/syntax/ftdetect/zelto-slice.vim"
TEST_FILE="$PROJECT_ROOT/specs/slices/v1-vim-syntax.md"

# Check if vim is available
if ! command -v vim >/dev/null 2>&1; then
  echo "SKIP: vim not installed — skipping syntax validation"
  exit 0
fi

# Verify files exist
if [ ! -f "$SYNTAX_FILE" ]; then
  echo "FAIL: $SYNTAX_FILE not found"
  exit 1
fi

if [ ! -f "$FTDETECT_FILE" ]; then
  echo "FAIL: $FTDETECT_FILE not found"
  exit 1
fi

if [ ! -f "$TEST_FILE" ]; then
  echo "SKIP: test file $TEST_FILE not found — using inline test content"
  TEST_FILE=$(mktemp)
  cat > "$TEST_FILE" << 'EOF'
---
id: v1-vim-syntax
title: Vim syntax highlighting
---

## Purpose

Provide Vim syntax highlighting for slice specs.

- [x] syntax file exists
- [ ] all tests pass

Status: completed

TODO: add more tests
> A blockquote with a [link](https://example.com)
EOF
  CLEANUP_TEMP=true
fi

# Run vim syntax check
echo "Checking Vim syntax file: $SYNTAX_FILE"
if vim -c "syntax on" \
       -c "source $SYNTAX_FILE" \
       -c "set filetype=zelto-slice" \
       -c "redir @a" \
       -c "silent syntax list" \
       -c "redir END" \
       -c "q" \
       "$TEST_FILE" >/dev/null 2>&1; then
  echo "PASS: Vim syntax file loads without errors"
else
  echo "FAIL: Vim encountered an error loading syntax file"
  exit 1
fi

# Clean up temp file if created
if [ "$CLEANUP_TEMP" = "true" ] && [ -n "$TEST_FILE" ]; then
  rm -f "$TEST_FILE"
fi

exit 0
