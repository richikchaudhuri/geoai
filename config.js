// Prefer one HTTPS origin for /gis/app/ and the /gis/ API. No keys are required.
// Set apiBase for separate hosting; shareBaseUrl is the public dashboard URL in native hosts.
// To use the original citizen tables directly, explicitly configure
// { dataSource: 'supabase', supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
//   supabaseAnonKey: 'YOUR_PUBLIC_PUBLISHABLE_OR_ANON_KEY', shareBaseUrl: 'YOUR_PUBLIC_MAP_URL' }.
// That source provides citizen observations only. It never falls back to sample
// data or supplies video drives; a configured GIS source remains independent.
window.GIS_CONFIG = { apiBase: "", shareBaseUrl: "" };
