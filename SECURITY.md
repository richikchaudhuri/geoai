# Security Posture

This document describes the threat model, the mitigations actually
shipped in this repo, and — honestly — the things that aren't possible
without becoming Apple. Read it end-to-end before assuming the system
is "Apple-level secure."

## Threat model

| Actor | What they can attempt |
|---|---|
| Drive-by web visitor | Spam-refresh the public dashboard, scrape data, embed the function in a 3rd-party site |
| Determined web attacker | Inject XSS via malicious distress description, deface the site, hijack Cloudinary/Supabase keys to flood our quotas |
| Determined mobile attacker | Decompile the APK, extract Cloudinary preset + Supabase anon key, write a script to spam-upload garbage |
| Network-on-path attacker | TLS-MITM the mobile uploads, read photo content + GPS in transit |
| Backend operator (us) | We can read everything; this is true of every cloud service. Secure Enclave-class protections require custom silicon. |

## What's structurally impossible for us

A static-website + sideloadable Android APK can't reach Apple-class
guarantees because:

- **No hardware Secure Enclave.** Apple stores keys in custom silicon
  isolated from the OS. We're a public web app + Android APK. Nothing
  to put in an enclave.
- **No App Store review.** Apple reviews every iOS app for malicious
  code before it reaches users. Sideloaded APKs and direct-deployed
  websites have no such gate.
- **No end-to-end encryption.** The whole point of the WebGIS is that
  civic authorities can *see* the data. E2EE would defeat that.
- **No Advanced Data Protection / iCloud E2EE.** No user accounts,
  nothing to encrypt at rest beyond what Supabase already does.
- **No code signing root of trust.** Our debug-keystore-signed APK is
  trivially re-signable. A real release keystore (deferred until Play
  Store submission) provides developer-identity continuity but not
  Apple-style attestation.

What we CAN do is layer enough protections that bypassing them is
expensive and noisy. Here's what's shipped.

---

## Web (WebGIS)

### Transport

- **TLS 1.2+ enforced** by Netlify (not configurable down).
- **HTTP Strict Transport Security** with 2-year max-age and `preload`
  + `includeSubDomains` — once browsers cache it, the domain literally
  cannot be visited over plain HTTP for 2 years.

### Browser sandboxing

- **Content-Security-Policy** locked to known-good script/style/img/
  font/connect/frame sources. Inline-script XSS is impossible
  (CSP without `'unsafe-inline'` for scripts), 3rd-party CDN injection
  is blocked, and the site can't be iframed (`frame-ancestors 'none'`).
- **X-Frame-Options DENY** — clickjacking-resistant.
- **X-Content-Type-Options nosniff** — no MIME-type guessing.
- **Permissions-Policy** denies `camera`, `microphone`, `payment`,
  `usb`, FLoC cohort tracking. Geolocation is allowed only for `self`.
- **Cross-Origin-Opener-Policy: same-origin** + **Cross-Origin-
  Resource-Policy: same-origin** — Spectre-class isolation.
- **Referrer-Policy: strict-origin-when-cross-origin** — minimal
  referer leakage.

### Supply-chain integrity

- **Subresource Integrity** on every CDN script with sha-256/sha-384
  hashes. Leaflet 1.9.4 + Supabase 2.50.0 are pinned to specific
  versions; if the CDN ever serves a tampered file, the browser
  refuses to execute it.
- **`crossorigin="anonymous"` + `referrerpolicy="no-referrer"`** on
  all CDN tags so the CDN can't fingerprint our visitors.

### API surface

- **Netlify Function** at `/.netlify/functions/assessments` is the
  only server-side surface, and it's hardened with:
  - Per-IP sliding-window **rate limit** (60 req/min sustained,
    5 req/sec burst) backed by Upstash Redis pipelines
  - **CORS allowlist** — only `gisgeoai.netlify.app` + localhost
    origins. No `*` wildcard.
  - **Origin/Referer enforcement** — direct cURL / random sites get
    403'd
  - **Method whitelist** — GET + OPTIONS only
  - **Bot user-agent blocklist** — curl, wget, python-requests, scrapy,
    nmap, nuclei, and friends get rejected
  - **8-second timeout** on the upstream Supabase fetch so a slow-loris
    attack can't pin Function compute
  - **Graceful degradation** — if Upstash is unreachable, the function
    still works (degrades to direct Supabase) instead of black-holing
    legit users

### Data layer (Supabase)

- **Row-Level Security** is the actual gatekeeper, not the anon key:
  - `assessments` has a `Public read classified assessments` policy
    that limits anon-role SELECT to `status IN ('classified','done',
    'expert_review')`
  - `photos` has `Public read photos`
  - All other tables are anon-deny by default
- **Anon JWT in client JS** is intentional and documented by Supabase.
  RLS protects the rows; key secrecy doesn't.
- **What's not yet shipped (manual setup):** a Postgres trigger that
  rate-limits photo INSERTs by recent count. See "Recommended manual
  hardening" below.

### Cloudinary

- **Unsigned upload preset** — designed to be public. The preset name
  is not a secret.
- **What's not yet shipped (Cloudinary dashboard):** restrict the
  preset to images only, max 10 MB, max 4096×4096 dimensions, fixed
  folder. See "Recommended manual hardening" below.

---

## Mobile (Android)

### Transport

- **`usesCleartextTraffic="false"`** in AndroidManifest — blocks ALL
  http:// (non-TLS) network traffic at the OS level.
- **`networkSecurityConfig`** xml file pins the app to:
  - TLS 1.2+ only (no SSLv3, no TLS 1.0/1.1)
  - System CAs only (no user-installed root CAs accepted, defeats
    common MITM proxies on rooted devices)
- **Apple ATS analog** is achieved without hard pins, since cert pins
  brick the app whenever Cloudinary/Supabase rotate certs on schedule.

### Backup / data extraction

- **`allowBackup="false"`** — Google Drive auto-backup of the app's
  data is disabled. Even if user's backup is exfiltrated, the app
  data isn't in it.
- **`dataExtractionRules`** + **`fullBackupContent`** explicitly
  exclude `msc_prefs.xml` (location history, cooldown timestamps,
  upload history) from cloud-backup AND device-to-device transfers.

### Code obfuscation

- **R8/ProGuard enabled** (`isMinifyEnabled = true`,
  `isShrinkResources = true`) on release builds:
  - Kotlin / Java class & method names obfuscated
  - Unused code stripped from the APK
  - Reverse-engineering with apktool / jadx returns gibberish-named
    classes instead of clear symbols
- ProGuard rules in `proguard-rules.pro` keep just enough of CameraX,
  Play Services Location, OSMDroid, OkHttp, and Coroutines for
  reflection paths to work; everything else is fair game.

### Application-level rate limiting

- **6-second cooldown** between captures (existing).
- **Hourly hard cap of 60 captures** persisted in SharedPreferences.
  Defense in depth: even if a tampered build removes the cooldown,
  this cap still applies.
- **Cooldown survives app restart** (timestamp persisted) — killing
  the app and reopening it doesn't reset the rate limit.

### WebView hardening

- `WebView.MetricsOptOut = true` (no Google metrics from any embedded
  web content)
- `WebView.EnableSafeBrowsing = true` (Google Safe Browsing protects
  against malicious URLs)

### Permissions

- Only the bare minimum requested: `CAMERA`, `ACCESS_FINE_LOCATION`,
  `ACCESS_COARSE_LOCATION`, `INTERNET`, `ACCESS_NETWORK_STATE`.
  No `READ_EXTERNAL_STORAGE`, no `READ_CONTACTS`, no `RECORD_AUDIO`.
- `targetSdk = 36` (Android 16) means runtime-permission prompts are
  enforced; the user can revoke camera or location at any time.

---

## Recommended manual hardening

These steps live outside this repo (Cloudinary dashboard, Supabase
SQL Editor) so they're documented here and you run them once.

### Cloudinary upload preset (5 min)

1. https://console.cloudinary.com → **Settings** → **Upload** →
   find your `photos` preset → **Edit**
2. **Allowed formats**: `jpg, png, webp` only (block `pdf, svg, html,
   exe`, etc. — SVG can carry XSS, HTML obvious)
3. **Max file size**: `10 MB` (a phone JPEG is ~3 MB; 10 MB is plenty)
4. **Max image width / height**: `4096`
5. **Folder**: lock to `geoai/` so abusers can't pollute the root
6. **Tags**: auto-add `source:geoai-mobile` so you can audit-tag
   legit uploads
7. **Notification URL** (optional): set to a webhook for upload-
   spike alerts
8. **Save**

### Supabase rate-limit policy (10 min)

In **Supabase SQL Editor**, run:

```sql
-- Per-IP rate limit on photos INSERT.
-- Limits anon inserts to 30 / minute per source IP.
-- Requires the inet_client_addr() Postgres function which is
-- exposed via Supabase's request headers.

create extension if not exists pgcrypto;

create table if not exists public.photo_insert_log (
    ip text not null,
    created_at timestamptz not null default now()
);
create index if not exists photo_insert_log_ip_time
    on public.photo_insert_log (ip, created_at desc);

create or replace function public.check_photo_insert_rate()
returns trigger language plpgsql as $$
declare
    client_ip text := coalesce(
        current_setting('request.headers', true)::json->>'x-forwarded-for',
        '0.0.0.0'
    );
    recent_count int;
begin
    select count(*) into recent_count
    from public.photo_insert_log
    where ip = client_ip
      and created_at > now() - interval '1 minute';

    if recent_count >= 30 then
        raise exception 'Rate limit: too many uploads from your IP';
    end if;

    insert into public.photo_insert_log (ip) values (client_ip);
    return new;
end;
$$;

drop trigger if exists rl_photo_insert on public.photos;
create trigger rl_photo_insert
    before insert on public.photos
    for each row execute function public.check_photo_insert_rate();

-- Periodic cleanup so the log table doesn't grow forever
create or replace function public.purge_old_insert_log()
returns void language sql as $$
    delete from public.photo_insert_log
    where created_at < now() - interval '1 hour';
$$;
```

Then in **Database → Cron** (or use `pg_cron` if available), schedule
`select public.purge_old_insert_log();` every hour.

### MapTiler key restriction (1 min)

1. https://cloud.maptiler.com → **Account** → **Keys** → click your
   key
2. Add **Allowed origins**: `https://gisgeoai.netlify.app/*`
3. **Save**. Now stolen keys can only be used from your domain.

---

## Reporting a vulnerability

Email **capstoneysl@gmail.com** with reproduction steps. Don't open a
public GitHub issue for security bugs. We'll acknowledge within 48 h
and aim to ship a fix within 7 days.

## Things we know are out of scope (not bugs)

- Anon JWT visible in client JS — by design (RLS protects rows)
- Cloudinary cloud name + preset visible in APK — by design (unsigned
  preset is meant to be public)
- MapTiler key visible in client JS — by design (gateway-restricted
  to allowed origins)
- Decompiled APK reveals function names if ProGuard is disabled — only
  applies to debug builds; release builds are obfuscated
