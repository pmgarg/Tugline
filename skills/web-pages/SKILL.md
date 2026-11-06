---
name: web-pages
description: Use when creating or changing an HTML page, landing page, UI component or small web app. Tells you how to build it so it works when opened from disk, and how to verify it in a real browser with the screenshot tool.
---
A page that looks right in code can be blank in a browser. Verify it the way a person opens it.

Build:
- Prefer one self-contained file (inline CSS/JS) unless the project already has a build setup.
- Never let the script die early: wrap `localStorage`/`sessionStorage` access in try/catch (they THROW on `file://` in some browsers and in sandboxed iframes). Persist preferences only inside that guard; keep the feature, guard the storage.
- Content must be visible without JavaScript animations completing: do not leave elements at `opacity:0` waiting for an IntersectionObserver that may never fire; add a no-JS / reduced-motion fallback.
- Wire every control to a visible effect (e.g. a theme toggle must change CSS variables that are actually used, not just an attribute).
- Responsive: test at 1280px and at 390px width.

Verify (required before you say it is done):
1. `screenshot` with `path` set to the file (file:// origin), `check_no_js: true`.
2. Read the report: uncaught JS errors must be none; visible characters should be substantial; with JS disabled there should still be readable text.
3. `screenshot` again with `width: 390` for mobile.
4. If anything fails, fix it and re-run the check. Report the final check results in your answer.
Do not "fix" a failing check by removing the feature it tests.
