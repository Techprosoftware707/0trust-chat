#!/usr/bin/env bash
# Chat (vitest after clearing the vitest file cache, lint, typecheck, build), deploy unittests,
# the CI shared checks and brand contrast; each recorded in docs/nexus/evidence/final/.
set -u
Q=/tmp/claude-0/-home-user/e6bb18e2-ef15-525e-9375-04c4a4514dbf/scratchpad/qa
R="$Q/rec.sh"; E=/home/user/nexus/docs/nexus/evidence/final; N=/home/user/nexus; C=$N/services/chat
summary="$Q/static-summary.txt"; : > "$summary"
run() { local f="$1"; shift; "$R" "$E/$f" "$@"; echo "$f exit=$?" | tee -a "$summary"; }
run chat-vitest.txt "$C" "find node_modules/.vitest-cache -maxdepth 1 -type f -delete && echo 'vitest cache cleared' && npm test 2>&1 | tail -40"
run chat-lint.txt "$C" "npm run lint 2>&1 | tail -20"
run chat-typecheck.txt "$C" "npm run typecheck 2>&1 | tail -20"
run chat-build.txt "$C" "npm run build 2>&1 | tail -25"
run chat-build-widget.txt "$C" "npm run --if-present build:widget 2>&1 | tail -10"
run deploy-unittests.txt "$N" "python3 -m unittest discover -s tests/deploy -v 2>&1 | tail -15"
run design-tokens-check.txt "$N" "python3 design/tools/gen_tokens.py --check"
run ci-shellcheck.txt "$N" "cat $Q/ci-shellcheck.sh; echo ---; bash $Q/ci-shellcheck.sh"
run ci-tls-bypass-grep.txt "$N" "cat $Q/ci-tls.sh; echo ---; bash $Q/ci-tls.sh"
run ci-secret-grep.txt "$N" "cat $Q/ci-secret.sh; echo ---; bash $Q/ci-secret.sh"
run brand-contrast.txt "$N" "python3 tests/nexus/brand_contrast.py 2>&1 | tail -8"
run portal-ruff.txt "$N/services/portal" "/home/user/nexus-venv/bin/ruff check --isolated --line-length 160 --select E,F,W,I apps/api apps/crm apps/integrations apps/assistant apps/mcp apps/automation apps/core/extensions.py tests/nexus_helpers.py tests/test_nexus_*.py ../../tests/nexus/brand_contrast.py"
echo "--- summary"; cat "$summary"
