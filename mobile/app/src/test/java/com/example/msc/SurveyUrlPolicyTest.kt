package com.example.msc

import org.junit.Assert.*
import org.junit.Test

class SurveyUrlPolicyTest {
    @Test fun normalizesHttpsOriginWithoutEmbeddingCredentialsOrPaths() {
        assertEquals("https://survey.example.org", SurveyUrlPolicy.normalizeOrigin(" https://SURVEY.example.org/ "))
        assertEquals("https://survey.example.org:8443", SurveyUrlPolicy.normalizeOrigin("https://survey.example.org:8443"))
        listOf("", "survey.example.org", "javascript:alert(1)", "file:///tmp/a", "https://user:pass@survey.example.org",
            "https://survey.example.org/gis/app/", "https://survey.example.org?token=a", "https://survey.example.org#x",
            "https://survey.example.org:0", "https://survey.example.org:65536", "https://survey.example.org\n").forEach {
            if (it.endsWith('\n')) assertEquals("https://survey.example.org", SurveyUrlPolicy.normalizeOrigin(it))
            else assertNull(it, SurveyUrlPolicy.normalizeOrigin(it))
        }
    }

    @Test fun cleartextIsLimitedToDebugLocalDevelopment() {
        listOf("localhost", "127.0.0.1", "10.0.2.2").forEach { host ->
            assertEquals("http://$host:8765", SurveyUrlPolicy.normalizeOrigin("http://$host:8765", true))
            assertNull(SurveyUrlPolicy.normalizeOrigin("http://$host:8765", false))
        }
        listOf("192.168.0.1", "localhost.example.org", "10.0.2.2.example.org", "evil.example.org").forEach {
            assertNull(SurveyUrlPolicy.normalizeOrigin("http://$it", true))
        }
    }

    @Test fun onlyBundledMainPageCanNavigateInsideTheWebView() {
        assertTrue(SurveyUrlPolicy.isAppPage(SurveyUrlPolicy.APP_URL + "?video=1#map"))
        assertTrue(SurveyUrlPolicy.isAppPage(SurveyUrlPolicy.APP_ORIGIN + "/gis/app/"))
        assertFalse(SurveyUrlPolicy.isAppPage("https://appassets.androidplatform.net.attacker.org/gis/app/"))
        assertFalse(SurveyUrlPolicy.isAppPage(SurveyUrlPolicy.APP_ORIGIN + "/other.html"))
        assertFalse(SurveyUrlPolicy.isAppPage("http://appassets.androidplatform.net/gis/app/"))
    }

    @Test fun exportsCannotContactAnUnrelatedOriginOrEndpoint() {
        val origin = "https://survey.example.org"
        assertTrue(SurveyUrlPolicy.isVideoExport("$origin/gis/video/segments.csv?severity=High&session=one", origin))
        assertTrue(SurveyUrlPolicy.isVideoExport("$origin:443/gis/video/segments.csv", origin))
        listOf("https://other.example.org/gis/video/segments.csv", "$origin/gis/meta", "$origin/gis/video/../segments.csv",
            "$origin/gis/video/segments.csv#x", "https://user@survey.example.org/gis/video/segments.csv", "$origin:8443/gis/video/segments.csv",
            "$origin/gis/video/%73egments.csv").forEach { assertFalse(it, SurveyUrlPolicy.isVideoExport(it, origin)) }
    }

    @Test fun shareLinksMustOpenTheConfiguredDashboard() {
        val origin = "https://survey.example.org"
        assertTrue(SurveyUrlPolicy.isSharedView("$origin/gis/app/?video=1&lat=12.9&lon=77.5#view", origin))
        assertFalse(SurveyUrlPolicy.isSharedView(SurveyUrlPolicy.APP_URL, origin))
        assertFalse(SurveyUrlPolicy.isSharedView("$origin/login?token=private", origin))
        assertFalse(SurveyUrlPolicy.isSharedView("https://survey.example.org.attacker.org/gis/app/", origin))
    }

    @Test fun citizenSharingUsesOnlyTheExistingHostedDashboardWithoutAllowingVideoDownloads() {
        assertTrue(SurveyUrlPolicy.isSharedView("https://gisgeoai.netlify.app/?lat=12.9&lon=77.5", ""))
        assertTrue(SurveyUrlPolicy.isSharedView("https://gisgeoai.netlify.app/index.html#map", ""))
        listOf("https://gisgeoai.netlify.app.attacker.org/", "http://gisgeoai.netlify.app/",
            "https://gisgeoai.netlify.app/gis/app/", "https://user@gisgeoai.netlify.app/",
            SurveyUrlPolicy.APP_URL).forEach { assertFalse(it, SurveyUrlPolicy.isSharedView(it, "")) }
        assertFalse(SurveyUrlPolicy.isVideoExport("https://gisgeoai.netlify.app/gis/video/segments.csv", ""))
        assertFalse(SurveyUrlPolicy.isSharedView("https://gisgeoai.netlify.app/", "https://survey.example.org"))
    }

    @Test fun fixtureOriginsCannotRedirectTheExistingPublicConnectionToAnotherServer() {
        assertEquals("http://127.0.0.1:18766", SurveyUrlPolicy.developmentOrigin("http://127.0.0.1:18766"))
        assertEquals("https://localhost:18766", SurveyUrlPolicy.developmentOrigin("https://localhost:18766"))
        listOf("https://other.example.org", "http://192.168.1.2", "https://localhost.evil.org",
            "http://user:password@127.0.0.1", "http://127.0.0.1/path").forEach {
            assertNull(SurveyUrlPolicy.developmentOrigin(it))
        }
    }

    @Test fun sharedCaptureAndCitizenSettingsUseAnHttpsProjectAndPublicRole() {
        assertNotNull(SurveyUrlPolicy.normalizeOrigin(PublicBackendConfig.SUPABASE_URL))
        val key = PublicBackendConfig.SUPABASE_PUBLIC_KEY
        val payload = String(java.util.Base64.getUrlDecoder().decode(key.split('.')[1]))
        assertTrue("The shared client key must retain only the existing public role", payload.contains("\"role\":\"anon\""))
        assertFalse(payload.contains("service_role"))
    }

    @Test fun documentNamesCannotEscapeTheDocumentPickerOrLoseTheirType() {
        assertEquals("survey.csv", SurveyUrlPolicy.csvFilename("../../survey.csv"))
        assertEquals("survey.csv", SurveyUrlPolicy.csvFilename("C:\\exports\\survey.csv"))
        assertEquals("geoai-survey.csv", SurveyUrlPolicy.csvFilename(""))
        assertEquals("data.csv", SurveyUrlPolicy.csvFilename("data"))
        assertEquals("bad_name.csv", SurveyUrlPolicy.csvFilename("bad\nname.csv"))
        assertTrue(SurveyUrlPolicy.csvFilename("x".repeat(200)).length <= 100)
    }

    @Test fun malformedControlCharacterAndOversizeUrlsNeverReachActions() {
        assertFalse(SurveyUrlPolicy.isWebLink("javascript:alert(1)"))
        assertFalse(SurveyUrlPolicy.isWebLink("https://survey.example.org/\nfoo"))
        assertFalse(SurveyUrlPolicy.isWebLink("https://survey.example.org/" + "x".repeat(32768)))
        assertFalse(SurveyUrlPolicy.isWebLink("https://user:password@survey.example.org/"))
        assertTrue(SurveyUrlPolicy.isWebLink("https://openfreemap.org/"))
    }

    @Test fun csvSizeUsesUtf8BytesAndReportsUnsupportedOrOversizedContent() {
        assertEquals(SurveyUrlPolicy.CsvContentValidation.VALID, SurveyUrlPolicy.validateCsvContent("abc,def\n", "text/csv;charset=utf-8", 8))
        assertEquals(SurveyUrlPolicy.CsvContentValidation.TOO_LARGE, SurveyUrlPolicy.validateCsvContent("abc,def\n", "text/csv", 7))
        assertEquals(SurveyUrlPolicy.CsvContentValidation.TOO_LARGE, SurveyUrlPolicy.validateCsvContent("€€", "text/csv", 5))
        assertEquals(SurveyUrlPolicy.CsvContentValidation.VALID, SurveyUrlPolicy.validateCsvContent("€€", "text/csv", 6))
        assertEquals(SurveyUrlPolicy.CsvContentValidation.VALID, SurveyUrlPolicy.validateCsvContent("🚗", "text/csv", 4))
        assertEquals(SurveyUrlPolicy.CsvContentValidation.TOO_LARGE, SurveyUrlPolicy.validateCsvContent("🚗", "text/csv", 3))
        assertEquals(SurveyUrlPolicy.CsvContentValidation.UNSUPPORTED_FORMAT, SurveyUrlPolicy.validateCsvContent("<html>", "text/html", 100))
    }
}
