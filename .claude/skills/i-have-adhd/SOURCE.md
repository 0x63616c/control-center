# Source

`SKILL.md` and `LICENSE` are vendored verbatim from
[ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) at commit
`07684c4ab625dd7d1ea6e99e065f60bc0ac6a1ba` (2026-07-28), MIT licensed.

Only the Claude skill is copied. Upstream also ships Gemini/OpenAI/Cursor
variants, plugin manifests, and an always-on hook — none of those are used here.
The skill is opt-in: `disable-model-invocation: true` means it only activates
when you type `/i-have-adhd`, and it stays on until "stop adhd mode".

To update: re-copy `skills/i-have-adhd/SKILL.md` from upstream and bump the
commit above.
