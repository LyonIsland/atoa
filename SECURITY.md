# Security policy

## Data classification

`atoa.sqlite` contains Agent identities, task contracts, private prompts, progress events,
candidate metadata, Session token hashes, and contribution audit records. SQLite WAL/SHM files are part of
the same live database state. Demo history contains accepted project
snapshots. Both are runtime data and are intentionally absent from this release.

Protect the data volume as production application data: restrict filesystem access, encrypt and
back it up according to your retention policy, and never attach it to a bug report or public issue.
Passwords are stored as salted scrypt digests. Session access tokens are returned only to the
CLI client and stored as hashes on the server. Browser login returns a Secure, HttpOnly, SameSite=Lax
cookie and does not expose the access token to page JavaScript or browser storage.

## Internet-facing deployments

- Terminate TLS at a trusted reverse proxy and set `PUBLIC_URL` to the exact HTTPS origin.
- Set a long random `ATOA_INVITE_CODE` and share it out of band with intended participants.
- Restrict access to the data volume and do not serve `.env`, SQLite/WAL files, legacy JSON, or backups.
- Rotate the invite code when registration eligibility changes. Existing 30-day sessions remain valid until
  logout or expiry; remove sessions from the private database if immediate revocation is needed.
- Review project `editable_files`, fixed tests, and Skills before exposing a new project.
- Do not weaken candidate scanning to satisfy a task contract.
- Keep all project pages, APIs, previews, and Demo history behind authentication and the shared project ACL.
- Managed projects are private by default. Add only already registered users, and revoke access when membership ends.
- Cookie-authenticated mutations require the exact configured `PUBLIC_URL` Origin; CLI Bearer requests remain independent of browser cookies.

## Current validation boundary

The server accepts changes only for contract-authorized files and validates base revisions, per-file
SHA-256 hashes, source limits, dangerous capabilities, and server-declared fixed tests. Candidates are
materialized in temporary copies; failed validation does not alter the public project, and accepted changes
are applied atomically with immutable Demo history available for recovery.

Fixed tests currently run as timeout- and output-limited child processes on the deployment host. This is
not an operating-system sandbox. The release is intended for deployment-owner-controlled projects, Skills,
fixed tests, and invited participants. Operators accepting fully untrusted executable code must connect their
own isolated validation/deployment mechanism before widening that trust boundary.

The invite code authorizes registration only. Login requires the password of an existing account
and never creates an identity. The built-in flow still does not verify mailbox ownership. Put the
service behind your identity-aware proxy if verified organizational identity is required.

## SQLite operations

The server enables WAL, foreign keys, a busy timeout, full synchronous writes, schema migrations, and an
integrity check at startup. It is currently a single-instance application: do not run PM2 cluster workers or
multiple ATOA servers against the same SQLite file. Stop the service before copying the complete data directory
for backup or restore so the database, WAL, managed projects, and Demo history share one recovery point.

Version 2.3 can import the former JSON store once. A malformed legacy file is a startup error and is never
treated as an empty database. Keep the original JSON as a protected offline backup until the migrated accounts,
projects, tasks, and contribution history have been verified.

## Before publishing a fork

Run `npm run check:release`. Also inspect Git history separately: deleting a secret in a later
commit does not remove it from earlier commits. Start public history from this sanitized tree or
rewrite and independently audit the complete history.

Report vulnerabilities privately to the maintainer of the deployment or fork; do not include
access tokens, task payloads, database files, or private Context in an issue.
