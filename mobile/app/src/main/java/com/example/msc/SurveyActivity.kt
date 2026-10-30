package com.example.msc

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.View
import android.webkit.SslErrorHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.example.msc.databinding.ActivitySurveyBinding
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.TimeUnit

/** The survey uses the same bundled dashboard as the web, with native sharing
 * and document export. No camera/location or file-access bridge is exposed. */
class SurveyActivity : AppCompatActivity() {
    private lateinit var binding: ActivitySurveyBinding
    private lateinit var assetLoader: WebViewAssetLoader
    @Volatile private var server = ""
    private var bridgeAvailable = false
    private var settingsDialog: AlertDialog? = null
    private var pendingExport: File? = null
    private var exportFilename = "geoai-survey.csv"
    private var exportInProgress = false
    private var rendererGone = false
    private class ExportTooLarge : Exception()
    private val prefs by lazy { getSharedPreferences("msc_prefs", MODE_PRIVATE) }
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()

    private val saveDocument = registerForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        val file = pendingExport
        pendingExport = null
        if (uri == null || file == null || !file.isFile) {
            file?.delete()
            exportInProgress = false
            binding.surveyProgress.visibility = View.GONE
            return@registerForActivityResult
        }
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    contentResolver.openOutputStream(uri, "wt")?.use { output ->
                        file.inputStream().use { input -> input.copyTo(output) }
                    } ?: error("Document not writable")
                }
                toast(R.string.survey_saved)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                showExportError(R.string.survey_export_failed)
            } finally {
                file.delete()
                exportInProgress = false
                binding.surveyProgress.visibility = View.GONE
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        binding = ActivitySurveyBinding.inflate(layoutInflater)
        setContentView(binding.root)
        ViewCompat.setOnApplyWindowInsetsListener(binding.surveyRoot) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            insets
        }
        server = SurveyUrlPolicy.normalizeOrigin(prefs.getString("survey_origin", BuildConfig.SURVEY_ORIGIN).orEmpty(), BuildConfig.DEBUG).orEmpty()
        val exportDirectory = File(cacheDir, "survey-exports").apply { mkdirs() }
        exportDirectory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > TimeUnit.DAYS.toMillis(1) }?.forEach { it.delete() }
        savedInstanceState?.getString("pendingExport")?.let { name ->
            val candidate = File(exportDirectory, name)
            if (name.startsWith("geoai-") && candidate.canonicalFile.parentFile == exportDirectory.canonicalFile && candidate.isFile) {
                pendingExport = candidate
                exportInProgress = true
            }
        }
        exportFilename = savedInstanceState?.getString("exportFilename") ?: exportFilename
        configureWebView()
        binding.surveyBack.setOnClickListener { finish() }
        binding.surveySettings.setOnClickListener { showServerSettings() }
        binding.surveyReload.setOnClickListener {
            if (rendererGone) recreate() else loadSurvey()
        }
        onBackPressedDispatcher.addCallback(this) {
            if (!rendererGone && binding.surveyWebView.canGoBack()) binding.surveyWebView.goBack() else finish()
        }
        val restored = savedInstanceState?.getBundle("webState")?.let { binding.surveyWebView.restoreState(it) }
        if (restored == null) loadSurvey() else {
            binding.surveyMessagePanel.visibility = View.GONE
            binding.surveyWebView.visibility = View.VISIBLE
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/gis/app/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        val web = binding.surveyWebView
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString GeoAI-Android"
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            bridgeAvailable = true
            WebViewCompat.addWebMessageListener(web, "GeoAIBridge", setOf(SurveyUrlPolicy.APP_ORIGIN)) { _, message, origin, mainFrame, _ ->
                val raw = runCatching { message.data }.getOrNull()
                if (mainFrame && origin.toString().trimEnd('/') == SurveyUrlPolicy.APP_ORIGIN && raw != null) {
                    if (raw.length > SurveyUrlPolicy.MAX_BRIDGE_MESSAGE_CHARS) showExportError(R.string.survey_export_too_large)
                    else receiveAction(raw)
                }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net") {
                    if (uri.path == "/gis/app/config.js") return scriptResponse(configurationScript())
                    val path = uri.path.orEmpty()
                    if (!path.startsWith("/gis/app/") || path.contains("..")) return missingAsset()
                    val assetPath = "survey/" + path.removePrefix("/gis/app/").ifBlank { "index.html" }
                    return assetLoader.shouldInterceptRequest(Uri.parse("${SurveyUrlPolicy.APP_ORIGIN}/gis/app/$assetPath")) ?: missingAsset()
                }
                return null
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val url = request.url.toString()
                if (SurveyUrlPolicy.isAppPage(url)) return false
                if (SurveyUrlPolicy.isVideoExport(url, server)) exportCsv(JSONObject().put("url", url))
                else openExternal(url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                binding.surveyProgress.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (!exportInProgress) binding.surveyProgress.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showFailure()
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                if (request.isForMainFrame) showFailure()
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                if (SurveyUrlPolicy.isAppPage(error.url)) showFailure()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                rendererGone = true
                (view.parent as? android.view.ViewGroup)?.removeView(view)
                view.destroy()
                showFailure()
                return true
            }
        }
        web.webChromeClient = WebChromeClient()
        web.setDownloadListener { url, _, _, _, _ ->
            if (SurveyUrlPolicy.isVideoExport(url, server)) exportCsv(JSONObject().put("url", url))
            else showExportError(R.string.survey_export_failed)
        }
    }

    private fun citizenOrigin(): String {
        if (BuildConfig.DEBUG && BuildConfig.CITIZEN_TEST_ORIGIN.isNotBlank()) {
            return checkNotNull(SurveyUrlPolicy.developmentOrigin(BuildConfig.CITIZEN_TEST_ORIGIN)) {
                "Citizen test origin must be an explicit loopback development host"
            }
        }
        return PublicBackendConfig.SUPABASE_URL
    }

    private fun configurationScript(): String {
        val config = if (server.isNotEmpty()) {
            JSONObject().put("apiBase", server).put("shareBaseUrl", "$server/gis/app/").put("dataSource", "gis")
        } else {
            val publicKey = if (BuildConfig.DEBUG && BuildConfig.CITIZEN_TEST_ORIGIN.isNotBlank())
                "sb_publishable_android_fixture" else PublicBackendConfig.SUPABASE_PUBLIC_KEY
            JSONObject().put("dataSource", "supabase").put("supabaseUrl", citizenOrigin())
                .put("supabaseAnonKey", publicKey).put("shareBaseUrl", SurveyUrlPolicy.CITIZEN_DASHBOARD_URL)
                .put("supabaseAllowLoopbackHttp", BuildConfig.DEBUG && BuildConfig.CITIZEN_TEST_ORIGIN.isNotBlank())
        }
        val nativeEvents = if (!bridgeAvailable) "" else """
            ['share', 'export'].forEach(function(action) {
              document.addEventListener('geoai:' + action, function(event) {
                if (!event.detail || !window.GeoAIBridge) return;
                event.preventDefault();
                if (action === 'export' && typeof event.detail.content === 'string' &&
                    new Blob([event.detail.content]).size > ${SurveyUrlPolicy.MAX_CSV_BYTES}) {
                  GeoAIBridge.postMessage(JSON.stringify({action:'export-error',detail:{reason:'too-large'}}));
                  return;
                }
                GeoAIBridge.postMessage(JSON.stringify({action:action, detail:event.detail}));
              });
            });
        """.trimIndent()
        return "window.GIS_CONFIG = $config;\n$nativeEvents"
    }

    private fun scriptResponse(text: String) = WebResourceResponse("application/javascript", "UTF-8", 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(text.toByteArray()))
    private fun missingAsset() = WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream("Not found".toByteArray()))

    private fun loadSurvey() {
        if (rendererGone) { recreate(); return }
        binding.surveyMessagePanel.visibility = View.GONE
        binding.surveyFeedback.visibility = View.GONE
        binding.surveyWebView.visibility = View.VISIBLE
        binding.surveyProgress.visibility = View.VISIBLE
        // Cleartext is permitted only for debug builds connected to one of
        // the explicit local development hosts in the network-security file.
        binding.surveyWebView.settings.mixedContentMode =
            if (BuildConfig.DEBUG && (server.ifEmpty { citizenOrigin() }).startsWith("http://")) WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE else WebSettings.MIXED_CONTENT_NEVER_ALLOW
        binding.surveyWebView.loadUrl(SurveyUrlPolicy.APP_URL)
    }

    private fun showFailure() {
        binding.surveyProgress.visibility = View.GONE
        binding.surveyWebView.visibility = View.GONE
        binding.surveyMessagePanel.visibility = View.VISIBLE
        binding.surveyMessageTitle.setText(R.string.survey_map)
        binding.surveyMessageBody.setText(R.string.survey_unavailable)
        binding.surveyMessageAction.setText(R.string.survey_retry)
        binding.surveyMessageAction.setOnClickListener { if (rendererGone) recreate() else loadSurvey() }
    }

    private fun showServerSettings() {
        if (exportInProgress) { toast(R.string.survey_export_busy); return }
        if (settingsDialog?.isShowing == true) return
        pauseReplay()
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (24 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
        }
        val input = EditText(this).apply {
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            hint = getString(R.string.survey_server_hint)
            setText(server)
            contentDescription = getString(R.string.survey_server)
        }
        container.addView(input)
        container.addView(TextView(this).apply { setText(R.string.survey_server_help) })
        val dialog = AlertDialog.Builder(this).setTitle(R.string.survey_server).setView(container)
            .setNegativeButton(android.R.string.cancel, null)
            .setNeutralButton(R.string.survey_use_citizen) { _, _ -> selectSource("") }
            .setPositiveButton(R.string.survey_connect, null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val normalized = SurveyUrlPolicy.normalizeOrigin(input.text.toString(), BuildConfig.DEBUG)
                if (normalized == null) input.error = getString(R.string.survey_server_invalid)
                else {
                    dialog.dismiss()
                    selectSource(normalized)
                }
            }
        }
        settingsDialog = dialog
        dialog.show()
    }

    private fun selectSource(origin: String) {
        if (!rendererGone && server != origin) {
            binding.surveyWebView.stopLoading()
            binding.surveyWebView.clearHistory()
            binding.surveyWebView.clearCache(false)
        }
        server = origin
        // Store the empty choice explicitly so a build-time GIS default does
        // not override the user's decision to return to the citizen map.
        prefs.edit().putString("survey_origin", server).apply()
        if (rendererGone) recreate() else loadSurvey()
    }

    private fun receiveAction(raw: String) {
        val message = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val detail = message.optJSONObject("detail")
        if (detail == null) {
            if (message.optString("action") == "export") showExportError(R.string.survey_export_failed)
            return
        }
        when (message.optString("action")) {
            "share" -> {
                val url = detail.optString("url")
                if (!SurveyUrlPolicy.isSharedView(url, server)) return
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, url)
                }, getString(R.string.survey_share_title)))
            }
            "export" -> exportCsv(detail)
            "export-error" -> showExportError(if (detail.optString("reason") == "too-large") R.string.survey_export_too_large else R.string.survey_export_failed)
        }
    }

    private fun exportCsv(detail: JSONObject) {
        if (exportInProgress) { toast(R.string.survey_export_busy); return }
        val url = detail.optString("url")
        val content = if (detail.has("content")) detail.optString("content") else null
        if (content != null) {
            when (SurveyUrlPolicy.validateCsvContent(content, detail.optString("mime"))) {
                SurveyUrlPolicy.CsvContentValidation.TOO_LARGE -> { showExportError(R.string.survey_export_too_large); return }
                SurveyUrlPolicy.CsvContentValidation.UNSUPPORTED_FORMAT -> { showExportError(R.string.survey_export_failed); return }
                SurveyUrlPolicy.CsvContentValidation.VALID -> Unit
            }
        } else if (!SurveyUrlPolicy.isVideoExport(url, server)) {
            showExportError(R.string.survey_export_failed)
            return
        }
        exportInProgress = true
        binding.surveyFeedback.visibility = View.GONE
        exportFilename = SurveyUrlPolicy.csvFilename(detail.optString("filename", "geoai-survey.csv"))
        binding.surveyProgress.visibility = View.VISIBLE
        lifecycleScope.launch {
            var file: File? = null
            try {
                file = withContext(Dispatchers.IO) {
                    val staged = File.createTempFile("geoai-", ".csv", File(cacheDir, "survey-exports"))
                    try {
                        if (content != null) staged.writeText(content)
                        else httpClient.newCall(Request.Builder().url(url).get().build()).execute().use { response ->
                            if (!response.isSuccessful) error("Export unavailable")
                            val body = response.body ?: error("Empty export")
                            if (body.contentLength() > SurveyUrlPolicy.MAX_CSV_BYTES) throw ExportTooLarge()
                            val mime = body.contentType()?.let { "${it.type}/${it.subtype}" }
                            if (mime !in setOf("text/csv", "application/csv", "application/octet-stream")) error("Unexpected export format")
                            body.byteStream().use { input -> staged.outputStream().use { output ->
                                val buffer = ByteArray(8192)
                                var total = 0
                                while (true) {
                                    ensureActive()
                                    val count = input.read(buffer)
                                    if (count == -1) break
                                    total += count
                                    if (total > SurveyUrlPolicy.MAX_CSV_BYTES) throw ExportTooLarge()
                                    output.write(buffer, 0, count)
                                }
                            } }
                        }
                        ensureActive()
                        staged
                    } catch (error: Exception) { staged.delete(); throw error }
                }
                pendingExport = file
                saveDocument.launch(exportFilename)
            } catch (cancelled: CancellationException) {
                file?.delete()
                throw cancelled
            } catch (error: Exception) {
                file?.delete()
                exportInProgress = false
                binding.surveyProgress.visibility = View.GONE
                showExportError(if (error is ExportTooLarge) R.string.survey_export_too_large else R.string.survey_export_failed)
            }
        }
    }

    private fun openExternal(url: String) {
        if (!SurveyUrlPolicy.isWebLink(url)) return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }

    private fun toast(message: Int) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    private fun showExportError(message: Int) {
        binding.surveyFeedback.setText(message)
        binding.surveyFeedback.visibility = View.VISIBLE
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        val webState = Bundle()
        if (!rendererGone) binding.surveyWebView.saveState(webState)
        outState.putBundle("webState", webState)
        pendingExport?.let { outState.putString("pendingExport", it.name) }
        outState.putString("exportFilename", exportFilename)
    }

    override fun onResume() { super.onResume(); if (!rendererGone) binding.surveyWebView.onResume() }
    private fun pauseReplay() {
        if (!rendererGone && SurveyUrlPolicy.isAppPage(binding.surveyWebView.url.orEmpty())) {
            // WebView.onPause does not suspend JavaScript timers. Dispatch to
            // the bundled page whenever native UI takes focus.
            binding.surveyWebView.evaluateJavascript("document.dispatchEvent(new Event('geoai:app-pause'));", null)
        }
    }

    override fun onPause() {
        pauseReplay()
        if (!rendererGone) {
            binding.surveyWebView.onPause()
        }
        super.onPause()
    }
    override fun onDestroy() {
        settingsDialog?.dismiss()
        if (!rendererGone) {
            binding.surveyWebView.stopLoading()
            binding.surveyWebView.destroy()
        }
        if (isFinishing) pendingExport?.delete()
        httpClient.dispatcher.cancelAll()
        super.onDestroy()
    }
}
