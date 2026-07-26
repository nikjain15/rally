# CLAUDE.md

This repository's contributor and agent guidance lives in [AGENTS.md](AGENTS.md).
Read it for setup, testing, conventions, project structure, and PR rules.

## Notes for Claude Code

- The rules and integration tests run under the Firebase emulator, which needs Java on your PATH. If `firebase emulators:exec` reports "Unable to locate a Java Runtime", add Java first, for example `export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"`.
- Keep the UI free of the word "AI"; it is always "Rally". Verify with `grep -rniE '\bA\.?I\b' app/`.
