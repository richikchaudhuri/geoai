# Capture timestamp migration

Apply `001_photos_captured_at.sql` in the Supabase project's SQL editor before sending new photo reports from this app. Use a database-owner/admin session; do not put privileged database or service-role credentials in the app. The existing `public.photos` table and backend integration must already be installed. This migration has been supplied as a file; it has not been executed against any database during development.

The migration adds nullable `photos.captured_at` (`TIMESTAMPTZ`) and requests a PostgREST schema-cache reload. It is safe to repeat. It does not backfill, overwrite or remove rows, alter RLS policies or grants, or change the existing photo-to-assessment trigger. Projects with column-specific grants may require their administrator to permit the existing upload role to insert this new column; no permissions are broadened by this migration.

`created_at` remains the upload timestamp. The backend trigger continues copying it to `assessments.created_at` for queue ordering. Original photo capture time belongs only in `captured_at`; use an ISO 8601 timestamp with an explicit timezone when it is known, and leave it null when unavailable. Latitude and longitude continue using the existing columns. Old rows remain null: their actual capture times cannot be recovered from upload timestamps.

The app's read path requests the new column explicitly. If an older database reports that `photos.captured_at` is missing, it retries once with the previous column list. Other HTTP, permissions or data errors remain errors. This allows browsing older deployments before the migration; new timestamp-bearing uploads require the migration and should report a setup error if the column is missing.

When the `captured_at` field is present, decoding uses its value: a null or invalid value means unknown capture time and unknown day/night. This applies both to new imports without capture metadata and to existing rows after the migration, because their new column remains null. A known capture timestamp determines day/night even if the photo is uploaded much later.

Only older schemas or snapshots that omit the `captured_at` field entirely retain the compatibility fallback to `photos.created_at`, then the assessment's `created_at`. Those legacy dates and day/night estimates use upload/queue time, not verified capture time. No capture times are inferred for migrated rows or written back to the database.

Verify the installed column without changing data:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'photos'
  AND column_name = 'captured_at';
```

Expected: `captured_at`, `timestamp with time zone`, `YES`. Existing upload policies, Cloudinary configuration and backend worker setup are separate prerequisites.
