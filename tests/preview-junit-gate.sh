#!/usr/bin/env bash
# Run inside the disposable 'tested' Docker stage, which contains Gradle's dependency cache.
set -euo pipefail
cd /app
work=$(mktemp -d)
mv src/test "$work/original-tests"
fixture=src/test/java/GateTest.java
mkdir -p "$(dirname "$fixture")"

expect_failure() {
  local scenario=$1 expected=$2
  local log="$work/$scenario.log"
  if gradle --offline --console=plain verifyPreviewTests > "$log" 2>&1; then
    cat "$log" >&2
    echo "$scenario unexpectedly passed" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$log"; then
    cat "$log" >&2
    exit 1
  fi
  printf '%s rejected: %s\n' "$scenario" "$expected"
}

# The image initially contains reports from a passing suite. They must not count again.
expect_failure no-source 'No passing JUnit test was executed'

cat > "$fixture" <<'JAVA'
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
class GateTest { @Test @Disabled void skipped() {} }
JAVA
expect_failure all-skipped 'No passing JUnit test was executed'

cat > "$fixture" <<'JAVA'
import org.junit.jupiter.api.Test;
class GateTest { @Test void broken() { throw new AssertionError("gate regression probe"); } }
JAVA
expect_failure failing-test 'GateTest > broken() FAILED'
