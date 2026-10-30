package com.example.msc

/** Existing public client settings shared by capture and citizen browsing.
 * The database still enforces its public-role permissions. No service key is used. */
internal object PublicBackendConfig {
    const val SUPABASE_URL = "https://vtlkitpoffudiefuoijb.supabase.co"
    const val SUPABASE_PUBLIC_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bGtpdHBvZmZ1ZGllZnVvaWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDAzMjIsImV4cCI6MjA4OTc3NjMyMn0.wLrwTky4k8iAELOvFbNeo063Z1rjQKOzzq3QYFqR6CU"
}
