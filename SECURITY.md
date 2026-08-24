# Security policy

sablejs treats sandbox escapes, host-object access, capability-boundary
bypasses, host-information disclosure, and Worker protocol vulnerabilities as
security issues.

## Supported versions

| Version | Security reports |
| --- | --- |
| 2.0.0 beta series | Supported |
| 1.1.x and earlier | Upgrade before requesting a fix |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Prefer GitHub's
[private vulnerability report](https://github.com/ErosZy/sablejs/security/advisories/new).
If that channel is unavailable, email `zyeros1991@gmail.com` with the subject
`sablejs security report`.

Include the affected version and host, a minimal reproducer, the expected and
observed boundary behavior, and any known impact. Remove secrets and personal
data from the report.

The maintainers aim to acknowledge a report within three business days and
provide an initial assessment within ten business days. Complex compiler or
sandbox issues may take longer to validate across optimization levels and the
pinned conformance suite. Please coordinate public disclosure until a fix and
permanent regression test are available.

The technical threat model, explicit policies, limitations, and historical
audit record are documented in [docs/security.md](docs/security.md).
