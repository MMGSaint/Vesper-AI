# GitHub security and automation

This file records what was actually configured. It does not invent GitHub features.

## Repository

Public source of truth: https://github.com/MMGSaint/Vesper-AI

The previous name `Vesper-personal-assistant-` redirects to `Vesper-AI`.

## Enabled (verified)

| Control | Status |
| --- | --- |
| Repository visibility | public |
| Dependabot alerts | enabled (204 from vulnerability-alerts API) |
| Dependabot security updates | enabled |
| Dependabot version updates | `.github/dependabot.yml` (npm + GitHub Actions, majors ignored) |
| Secret scanning | enabled |
| Secret scanning push protection | enabled |
| CodeQL default setup | disabled after it conflicted with advanced SARIF upload |
| CodeQL advanced workflow | `.github/workflows/codeql.yml` (push, PR, weekly, workflow_dispatch, `security-extended`) |
| CI | `.github/workflows/ci.yml` — typecheck, tests, security, hygiene, build |
| Nightly maintenance | `.github/workflows/nightly.yml` — tests + audit + report artifact; no deploy |
| Branch ruleset `Protect main` | active — blocks deletion and force-push; repository admins may bypass so autonomous development remains possible |
| Security policy | `SECURITY.md` |
| Least-privilege Actions | workflow `permissions: contents: read` unless a job needs `security-events: write` for CodeQL |

## Not enabled / not claimed

| Control | Reason |
| --- | --- |
| Secret scanning non-provider patterns | GitHub left this disabled on the account after the enable request |
| Secret scanning validity checks | Same GitHub-side limitation |
| Required status checks on every push to main | Would block autonomous admin pushes; PRs still run CI |
| Required pull requests | Would make agent pushes to main impossible |
| Artifact attestations | No distributable binaries/packages yet |
| GitHub Advanced Security extras beyond public-repo defaults | Not fully available on this user-owned public repo |

## Agent development

Agents with admin access can push to `main` because the ruleset bypasses repository admins. They must still:

1. Keep CI green
2. Never disable push protection
3. Never grant `write-all` to workflows
4. Never execute untrusted PR code with write tokens

## Hygiene

`npm run hygiene` fails the build if:

- a workflow is missing a `permissions:` block
- a `.env` or key file is tracked
- a high-confidence secret pattern is committed outside tests/docs
