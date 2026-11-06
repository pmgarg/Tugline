---
name: skill-creator
description: Use when the user asks to create, write, improve or package a new skill (a reusable SKILL.md that teaches the agent how to do a kind of work).
---
A skill is a folder with a SKILL.md: YAML frontmatter + markdown instructions. It changes HOW the agent works; it can never grant permissions.

Where to put it:
- Project skill (shared with the team via git): `.tugline/skills/<name>/SKILL.md`
- Personal skill (all projects): `~/.tugline/skills/<name>/SKILL.md`
(`.claude/skills` and `.agents/skills` are also discovered, so skills are portable between tools.)

Format:
```
---
name: kebab-case-name            # 1-64 chars, lowercase, digits, hyphens
description: Use when ... <what it does and WHEN to use it, with trigger words> (max ~1024 chars)
---
# Title
Short context: why this matters.
## Steps
1. ...
## Rules
- ...
## Verification
How to check the work is right.
```
Writing guidance:
- The description decides when the skill is used: start with "Use when", name the concrete situations and keywords.
- Keep SKILL.md under ~300 lines. Put long references, templates or scripts in sibling files (e.g. `reference.md`, `scripts/check.py`) and mention them in the body; they are read only when needed.
- Be concrete: exact commands, file names, checklists, examples of good output. Explain the reason behind each rule in one line.
- Include a verification step: how the agent proves the work is correct.
Process:
1. Ask (or infer) what repeated mistake or workflow the skill should fix, with 1-2 example tasks.
2. Write the skill with write_file. 3. Show the user the path and a summary. 4. Suggest a test prompt that should trigger it.
