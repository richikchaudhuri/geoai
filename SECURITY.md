# Security Policy

## Supported

This is an academic capstone project. We don't issue patched versions —
security fixes land directly on `main`.

## Reporting a vulnerability

If you discover a security issue (e.g., RLS misconfiguration on the
deployed Supabase instance, exposed secrets, an XSS in the WebGIS, an
auth bypass in the mobile app), please **don't open a public issue**.

Instead, email **capstoneysl@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce
- The impact (data exposure? defacement? user takeover?)
- Any suggested fix

We'll acknowledge within 48 hours and aim to ship a fix within 7 days
for high-severity issues.

## Known design decisions

A few things that *look* like vulnerabilities but are intentional:

- **Supabase anon key in client JS** — this is the standard Supabase
  pattern. The anon role's permissions are restricted by Row-Level
  Security (RLS), not by key secrecy. The anon key only grants public
  reads on the `assessments` and `photos` tables.
- **Cloudinary unsigned upload preset** — also by design. The preset
  restricts which transformations and folders are allowed; it can't
  delete or read existing assets.
- **MapTiler API key in client JS** — needs to be public to fetch tiles.
  It's restricted to the deployed origin via the MapTiler dashboard.

If you find a way these *aren't* sufficient (e.g., RLS bypass, preset
abuse, key leakage to an unintended domain), we definitely want to hear
about it.
