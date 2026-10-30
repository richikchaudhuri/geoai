package com.example.msc

import java.net.URI
import java.util.Locale

/** Pure URL policy, shared by configuration, navigation and native actions. */
object SurveyUrlPolicy {
    const val APP_ORIGIN = "https://appassets.androidplatform.net"
    const val APP_URL = "$APP_ORIGIN/gis/app/index.html"
    const val CITIZEN_DASHBOARD_URL = "https://gisgeoai.netlify.app/"
    const val MAX_CSV_BYTES = 10 * 1024 * 1024
    // JSON can escape one CSV character to six characters (for example a
    // control character). This transport cap is separate from UTF-8 file size.
    const val MAX_BRIDGE_MESSAGE_CHARS = MAX_CSV_BYTES * 6 + 65536
    private val developmentHosts = setOf("localhost", "127.0.0.1", "10.0.2.2")

    fun normalizeOrigin(value: String, allowDevelopmentHttp: Boolean = false): String? {
        val uri = parse(value.trim()) ?: return null
        if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") return null
        if (uri.rawQuery != null || uri.rawFragment != null) return null
        val scheme = uri.scheme.lowercase(Locale.ROOT)
        val host = uri.host.lowercase(Locale.ROOT)
        if (scheme != "https" && !(allowDevelopmentHttp && scheme == "http" && host in developmentHosts)) return null
        if (uri.port !in -1..65535 || uri.port == 0) return null
        return URI(scheme, null, host, uri.port, null, null, null).toASCIIString()
    }

    fun developmentOrigin(value: String): String? = normalizeOrigin(value, true)?.takeIf {
        URI(it).host.lowercase(Locale.ROOT) in developmentHosts
    }

    fun isAppPage(url: String): Boolean {
        val uri = parse(url) ?: return false
        return origin(uri) == APP_ORIGIN && (uri.path == "/gis/app/" || uri.path == "/gis/app/index.html")
    }

    fun isVideoExport(url: String, server: String): Boolean {
        val uri = parse(url) ?: return false
        val base = parse(server) ?: return false
        return origin(uri) == origin(base) && uri.rawPath == "/gis/video/segments.csv" && uri.rawFragment == null
    }

    fun isSharedView(url: String, server: String): Boolean {
        val uri = parse(url) ?: return false
        if (server.isBlank()) {
            val citizen = parse(CITIZEN_DASHBOARD_URL) ?: return false
            return origin(uri) == origin(citizen) && (uri.rawPath == "/" || uri.rawPath == "/index.html" || uri.rawPath == "")
        }
        val base = parse(server) ?: return false
        return origin(uri) == origin(base) && (uri.rawPath == "/gis/app/" || uri.rawPath == "/gis/app/index.html")
    }

    fun isWebLink(url: String): Boolean = parse(url)?.scheme?.lowercase(Locale.ROOT) in setOf("https", "http")

    fun csvFilename(raw: String): String {
        val clean = raw.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[^A-Za-z0-9._ -]"), "_").trim().take(96).ifBlank { "geoai-survey.csv" }
        return if (clean.lowercase(Locale.ROOT).endsWith(".csv")) clean else "$clean.csv"
    }

    enum class CsvContentValidation { VALID, UNSUPPORTED_FORMAT, TOO_LARGE }

    fun validateCsvContent(content: String, mime: String, maxBytes: Int = MAX_CSV_BYTES): CsvContentValidation {
        if (mime.substringBefore(';').trim().lowercase(Locale.ROOT) != "text/csv") return CsvContentValidation.UNSUPPORTED_FORMAT
        if (content.length > maxBytes || content.toByteArray(Charsets.UTF_8).size > maxBytes) return CsvContentValidation.TOO_LARGE
        return CsvContentValidation.VALID
    }

    private fun parse(value: String): URI? = runCatching {
        if (value.length > 32768 || value.any { it.isISOControl() }) return null
        URI(value).takeIf { it.isAbsolute && !it.host.isNullOrBlank() && it.rawUserInfo == null && it.scheme != null }
    }.getOrNull()

    private fun origin(uri: URI): String {
        val scheme = uri.scheme.lowercase(Locale.ROOT)
        val port = if ((scheme == "https" && uri.port == 443) || (scheme == "http" && uri.port == 80)) -1 else uri.port
        return URI(scheme, null, uri.host.lowercase(Locale.ROOT), port, null, null, null).toASCIIString()
    }
}
