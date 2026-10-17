#!/usr/bin/env bash
# Copied from .github/workflows/ci.yml "shellcheck"
git ls-files -z '*.sh' lumenctl install.sh update.sh backup.sh restore.sh healthcheck.sh diagnose.sh uninstall.sh \
  | xargs -0 shellcheck -x -S warning && echo "shellcheck -x -S warning: clean ($(git ls-files '*.sh' | wc -l) .sh files + top-level scripts)"
