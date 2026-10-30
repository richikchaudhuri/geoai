package com.example.msc

import android.content.Context
import android.content.Intent
import android.app.Activity
import android.app.Instrumentation
import android.view.View
import android.webkit.WebView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.closeSoftKeyboard
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.matcher.ViewMatchers.withContentDescription
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.Lifecycle
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject
import org.json.JSONTokener

@RunWith(AndroidJUnit4::class)
class SurveyActivityTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val preferences get() = context.getSharedPreferences("msc_prefs", Context.MODE_PRIVATE)
    private var previousOrigin: String? = null

    @Before fun prepare() {
        previousOrigin = preferences.getString("survey_origin", null)
        preferences.edit().putString("survey_origin", "").commit()
    }

    @After fun restore() {
        val edit = preferences.edit()
        if (previousOrigin == null) edit.remove("survey_origin") else edit.putString("survey_origin", previousOrigin)
        edit.commit()
    }

    @Test fun anUnconfiguredAppOpensTheExistingCitizenMapAndKeepsItAfterReloadAndRecreation() {
        // Fixture by default. A separate explicitly requested read-only smoke
        // can verify the final APK against its unchanged public project.
        val fixture = BuildConfig.CITIZEN_TEST_ORIGIN.isNotBlank()
        val liveRead = InstrumentationRegistry.getArguments().getString("surveyLiveReadSmoke") == "true"
        assumeTrue("Use a local fixture, or explicitly request the live read smoke", fixture || liveRead)
        val expectedOrigin = if (fixture) BuildConfig.CITIZEN_TEST_ORIGIN else PublicBackendConfig.SUPABASE_URL
        val citizenReady: (JSONObject) -> Boolean = { it.optString("source") == "supabase" &&
            (if (fixture) it.optInt("citizens") == 1 else it.optInt("citizens") > 0) }
        ActivityScenario.launch<SurveyActivity>(Intent(context, SurveyActivity::class.java)).use { scenario ->
            scenario.onActivity { activity ->
                assertEquals(View.GONE, activity.findViewById<View>(R.id.surveyMessagePanel).visibility)
                assertEquals(View.VISIBLE, activity.findViewById<WebView>(R.id.surveyWebView).visibility)
                val settings = activity.findViewById<WebView>(R.id.surveyWebView).settings
                assertFalse(settings.allowFileAccess)
                assertFalse(settings.allowContentAccess)
                assertFalse(settings.javaScriptCanOpenWindowsAutomatically)
            }
            awaitPageLoad(scenario)
            val initial = awaitState(scenario, citizenStateScript, citizenReady)
            assertEquals(expectedOrigin, initial.getString("origin"))
            assertEquals(SurveyUrlPolicy.CITIZEN_DASHBOARD_URL, initial.getString("share"))
            assertTrue(initial.optBoolean("publicKeyPresent"))
            assertEquals("No invented drive data may appear in citizen mode", 0, initial.optInt("sessions"))
            evaluate(scenario, "document.getElementById('videoToggle').click(); true")
            val unavailable = awaitState(scenario, citizenStateScript) { it.optString("videoNotice").contains("not connected") }
            assertEquals("Citizen mode must never substitute sample drive frames", 0, unavailable.optInt("videoFeatures"))
            evaluate(scenario, "document.querySelector('[data-page=map]').click(); true")
            awaitState(scenario, citizenStateScript) { citizenReady(it) && !it.optBoolean("videoEnabled") }
            scenario.onActivity { it.findViewById<View>(R.id.surveyReload).performClick() }
            awaitPageLoad(scenario)
            awaitState(scenario, citizenStateScript, citizenReady)
            scenario.recreate()
            awaitPageLoad(scenario)
            awaitState(scenario, citizenStateScript, citizenReady)
            scenario.onActivity { activity ->
                assertEquals(View.GONE, activity.findViewById<View>(R.id.surveyMessagePanel).visibility)
            }
            println("Android citizen first launch: source=supabase, observations=" + initial.getInt("citizens") +
                ", total=" + initial.optInt("total", -1) + ", sessions=0, fixture=" + fixture + "; reload and recreation retain the citizen map")
        }
    }

    @Test fun optionalDriveSettingsCanConnectAndReturnToCitizenMapWithoutFallingBackOnFailure() {
        assumeTrue("Build with geoaiCitizenTestOrigin for local citizen integration", BuildConfig.CITIZEN_TEST_ORIGIN.isNotBlank())
        val gisOrigin = "http://127.0.0.1:18767" // deliberately unavailable
        ActivityScenario.launch<SurveyActivity>(Intent(context, SurveyActivity::class.java)).use { scenario ->
            awaitState(scenario, citizenStateScript) { it.optString("source") == "supabase" && it.optInt("citizens") == 1 }
            scenario.onActivity { it.findViewById<View>(R.id.surveySettings).performClick() }
            onView(withContentDescription(R.string.survey_server)).perform(replaceText(gisOrigin), closeSoftKeyboard())
            onView(withId(android.R.id.button1)).perform(click())
            awaitPageLoad(scenario)
            val configured = awaitState(scenario, citizenStateScript) { it.optString("source") == "gis" && it.optBoolean("gisError") }
            assertEquals("An unavailable configured GIS server must not switch sources", gisOrigin, configured.getString("origin"))
            assertEquals(gisOrigin, preferences.getString("survey_origin", null))
            scenario.onActivity { it.findViewById<View>(R.id.surveySettings).performClick() }
            onView(withId(android.R.id.button3)).perform(click())
            awaitPageLoad(scenario)
            awaitState(scenario, citizenStateScript) { it.optString("source") == "supabase" && it.optInt("citizens") == 1 }
            assertEquals("The return choice must override a build-time GIS default", "", preferences.getString("survey_origin", null))
            scenario.recreate()
            awaitPageLoad(scenario)
            awaitState(scenario, citizenStateScript) { it.optString("source") == "supabase" && it.optInt("citizens") == 1 }
        }
    }

    private val citizenStateScript = """
        JSON.stringify({
          source:window.GIS_CONFIG?.dataSource || '',
          origin:window.GIS_CONFIG?.supabaseUrl || window.GIS_CONFIG?.apiBase || '',
          share:window.GIS_CONFIG?.shareBaseUrl || '',
          publicKeyPresent:!!window.GIS_CONFIG?.supabaseAnonKey,
          citizens:window.geoaiSurvey?.features?.length ?? -1,
          total:window.geoaiSurvey?.sourceStats?.total ?? -1,
          sessions:window.geoaiSurvey?.sessions?.length ?? -1,
          videoEnabled:!!window.geoaiVideoPaths?.enabled,
          videoFeatures:window.geoaiVideoPaths?.features?.length ?? -1,
          videoNotice:document.getElementById('videoNotice')?.textContent || '',
          gisError:document.querySelector('.survey-message')?.textContent?.includes('unavailable') ||
            document.querySelector('.survey-message')?.textContent?.includes('Failed') ||
            document.querySelector('.survey-message')?.textContent?.includes('fetch') || false
        })
    """.trimIndent()

    @Test fun bundledDashboardLoadsVideoControlAndInjectedConnection() {
        // No mock data is packaged: this unused loopback address deliberately
        // fails network requests while the bundled page remains inspectable.
        preferences.edit().putString("survey_origin", "http://127.0.0.1:18765").commit()
        ActivityScenario.launch<SurveyActivity>(Intent(context, SurveyActivity::class.java)).use { scenario ->
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
            var result = ""
            do {
                val latch = CountDownLatch(1)
                val value = AtomicReference<String>("")
                scenario.onActivity { activity ->
                    activity.findViewById<WebView>(R.id.surveyWebView).evaluateJavascript(
                        "JSON.stringify({ready:document.readyState,video:!!document.getElementById('videoToggle'),config:window.GIS_CONFIG&&window.GIS_CONFIG.apiBase,share:window.GIS_CONFIG&&window.GIS_CONFIG.shareBaseUrl,bridge:typeof window.GeoAIBridge})"
                    ) { json -> value.set(json); latch.countDown() }
                }
                assertTrue("WebView stopped responding", latch.await(20, TimeUnit.SECONDS))
                result = value.get()
                if (result.contains("18765") && result.contains("video\\\":true")) break
                Thread.sleep(100)
            } while (System.nanoTime() < deadline)
            assertTrue("Bundled video control missing: $result", result.contains("video\\\":true"))
            assertTrue("Configured API origin missing: $result", result.contains("http://127.0.0.1:18765"))
            assertTrue("Share links must open real GIS dashboard: $result", result.contains("http://127.0.0.1:18765/gis/app/"))
            assertTrue("Origin-scoped native bridge missing: $result", result.contains("bridge\\\":\\\"object"))
            scenario.recreate()
            scenario.onActivity { activity ->
                assertEquals("Restored map was covered by the Connect panel", View.GONE, activity.findViewById<View>(R.id.surveyMessagePanel).visibility)
                assertEquals(View.VISIBLE, activity.findViewById<WebView>(R.id.surveyWebView).visibility)
            }
        }
    }

    @Test fun configuredMockApiIsReachableFromTheBundledSecureOrigin() {
        val origin = InstrumentationRegistry.getArguments().getString("surveyTestOrigin").orEmpty()
        assumeTrue("Supply surveyTestOrigin and a reachable mock to run API integration", origin.isNotEmpty())
        assertNotNull(SurveyUrlPolicy.normalizeOrigin(origin, true))
        preferences.edit().putString("survey_origin", origin).commit()
        ActivityScenario.launch<SurveyActivity>(Intent(context, SurveyActivity::class.java)).use { scenario ->
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
            var result = ""
            var started = false
            do {
                val latch = CountDownLatch(1)
                val value = AtomicReference<String>("")
                scenario.onActivity { activity ->
                    val web = activity.findViewById<WebView>(R.id.surveyWebView)
                    val script = if (started) "document.body && document.body.dataset.nativeApiCheck" else """
                        (function() {
                          if (!document.body || !window.GIS_CONFIG) return 'waiting';
                          if (!document.body.dataset.nativeApiCheck) {
                            document.body.dataset.nativeApiCheck='loading';
                            fetch(${JSONObject.quote("$origin/gis/meta")}).then(function(response){
                              if (!response.ok) throw new Error('HTTP ' + response.status);
                              return response.json();
                            }).then(function(data){
                              document.body.dataset.nativeApiCheck=data.schema;
                            }).catch(function(error){document.body.dataset.nativeApiCheck=String(error);});
                          }
                          return document.body.dataset.nativeApiCheck;
                        })();
                    """.trimIndent()
                    web.evaluateJavascript(script) { json -> value.set(json); latch.countDown() }
                }
                assertTrue(latch.await(20, TimeUnit.SECONDS))
                result = value.get()
                if (result.contains("loading")) started = true
                if (result == "null") started = false
                if (result.contains("geoai.gis.v1")) break
                Thread.sleep(100)
            } while (System.nanoTime() < deadline)
            assertTrue("API fetch failed from bundled WebView: $result", result.contains("geoai.gis.v1"))
        }
    }

    @Test fun nativeCsvBridgeHandlesSaveCancellationAndShowsOversizeAndFormatErrors() {
        preferences.edit().putString("survey_origin", "http://127.0.0.1:18765").commit()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val pickerCount = AtomicInteger(0)
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                if (intent.action != Intent.ACTION_CREATE_DOCUMENT) return null
                pickerCount.incrementAndGet()
                return Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
            }
        }
        instrumentation.addMonitor(monitor)
        try {
            ActivityScenario.launch<SurveyActivity>(Intent(context, SurveyActivity::class.java)).use { scenario ->
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
                var sent = false
                do {
                    val latch = CountDownLatch(1)
                    val value = AtomicReference<String>("")
                    scenario.onActivity { activity ->
                        activity.findViewById<WebView>(R.id.surveyWebView).evaluateJavascript("""
                            (function() {
                              if (!window.GIS_CONFIG || typeof window.GeoAIBridge !== 'object') return 'waiting';
                              var event = new CustomEvent('geoai:export', {cancelable:true,detail:{
                                content:'id,label\n1,Potholes\n', mime:'text/csv;charset=utf-8', filename:'geoai-test.csv'
                              }});
                              document.dispatchEvent(event);
                              return event.defaultPrevented ? 'sent' : 'waiting';
                            })();
                        """.trimIndent()) { json -> value.set(json); latch.countDown() }
                    }
                    assertTrue(latch.await(20, TimeUnit.SECONDS))
                    sent = value.get().contains("sent")
                    if (sent) break
                    Thread.sleep(100)
                } while (System.nanoTime() < deadline)
                assertTrue("Native export listener was not installed", sent)
                while (pickerCount.get() == 0 && System.nanoTime() < deadline) Thread.sleep(100)
                assertEquals("CSV should open exactly one save picker", 1, pickerCount.get())
                instrumentation.waitForIdleSync()
                val files = java.io.File(context.cacheDir, "survey-exports").listFiles().orEmpty()
                assertTrue("Cancelled export left a temporary CSV", files.isEmpty())
                evaluate(scenario, """
                    document.dispatchEvent(new CustomEvent('geoai:export', {cancelable:true,detail:{
                      content:'x'.repeat(${SurveyUrlPolicy.MAX_CSV_BYTES + 1}), mime:'text/csv', filename:'too-large.csv'
                    }})); true
                """.trimIndent())
                awaitNativeFeedback(scenario, R.string.survey_export_too_large)
                evaluate(scenario, """
                    document.dispatchEvent(new CustomEvent('geoai:export', {cancelable:true,detail:{
                      content:'not a CSV export', mime:'text/html', filename:'unsupported.csv'
                    }})); true
                """.trimIndent())
                awaitNativeFeedback(scenario, R.string.survey_export_failed)
                assertEquals("Rejected exports must not open save pickers", 1, pickerCount.get())
            }
        } finally {
            instrumentation.removeMonitor(monitor)
        }
    }

    @Test fun completeSurveyPageLoadsCitizensVideoDistanceAndSharedConfidenceFilter() {
        val origin = InstrumentationRegistry.getArguments().getString("surveyTestOrigin").orEmpty()
        assumeTrue("Supply surveyTestOrigin for the full map integration", origin.isNotEmpty())
        preferences.edit().putString("survey_origin", origin).commit()
        ActivityScenario.launch<SurveyActivity>(Intent(context, SurveyActivity::class.java)).use { scenario ->
            val stateScript = """
                JSON.stringify({
                  ready:!!document.querySelector('#loadingScreen.done'),
                  status:document.getElementById('status')?.textContent||'',
                  maps:Array.from(document.querySelectorAll('.settings-option')).map(function(b){return b.dataset.loadState||'loading';}),
                  notice:document.getElementById('mapNotice')?.textContent||'',
                  video:document.getElementById('videoToggle')?.getAttribute('aria-pressed'),
                  distance:document.getElementById('videoDistanceLabel')?.textContent||'',
                  counts:document.querySelector('.survey-counts')?.textContent||'',
                  clusters:document.querySelectorAll('.video-distress-cluster').length,
                  citizenOnMap:typeof map !== 'undefined' && !!window.geoaiSurvey?.layer && map.hasLayer(window.geoaiSurvey.layer),
                  driveMenu:document.getElementById('videoDriveDetails')?.textContent || '',
                  filter:!!document.querySelector('input[name=highConfidence]')
                })
            """.trimIndent()
            val initial = awaitState(scenario, stateScript) { it.optBoolean("ready") && it.optString("status").startsWith("131 ") && it.optBoolean("filter") }
            assertTrue("Map mode must display citizen observations", initial.optBoolean("citizenOnMap"))
            val maps = initial.getJSONArray("maps")
            assertEquals(6, maps.length())
            for (i in 0 until maps.length()) assertTrue("Unsettled map: $initial", maps.getString(i) in setOf("ready", "failed"))
            assertTrue("Map failure had no explanation: $initial", (0 until maps.length()).any { maps.getString(it) == "ready" } || initial.optString("notice").isNotBlank())
            evaluate(scenario, "document.getElementById('videoToggle').click(); true")
            val video = awaitState(scenario, stateScript) {
                it.optString("video") == "true" && it.optString("distance") == "4.06 km travelled" && it.optString("counts").contains("164 distressed video segments")
            }
            assertFalse("Drive mode must hide walking/citizen observations", video.optBoolean("citizenOnMap"))
            assertTrue("Overview must group nearby video observations", video.getInt("clusters") > 0)
            assertTrue("All recorded drive routes must stay available", video.optString("driveMenu").contains("3 drives · 3 routes"))
            evaluate(scenario, "document.querySelector('input[name=highConfidence]').click(); true")
            val filtered = awaitState(scenario, stateScript) { it.optString("counts").contains("47 distressed video segments") }
            assertEquals("Distance must remain the total drive length", "4.06 km travelled", filtered.optString("distance"))
            assertFalse("Filtering must not restore citizen markers in drive mode", filtered.optBoolean("citizenOnMap"))
            evaluate(scenario, "document.querySelector('input[name=highConfidence]').click(); document.querySelector('[data-page=map]').click(); true")
            val off = awaitState(scenario, stateScript) { it.optString("video") == "false" && it.optString("status").startsWith("131 ") && it.optBoolean("citizenOnMap") }
            assertTrue(off.optString("counts").contains("Video layer off"))
            println("Android real-page basemap states: $maps; initial/video/confidence/reset counts and drive-versus-citizen map visibility verified")
        }
    }

    @Test fun routeReplayKeepsFramesInlineAndStaysPausedAfterBackgrounding() {
        val origin = InstrumentationRegistry.getArguments().getString("surveyTestOrigin").orEmpty()
        assumeTrue("Supply surveyTestOrigin for route replay integration", origin.isNotEmpty())
        preferences.edit().putString("survey_origin", origin).commit()
        ActivityScenario.launch<SurveyActivity>(Intent(context, SurveyActivity::class.java)).use { scenario ->
            val stateScript = """
                JSON.stringify({
                  loaded:!!document.querySelector('#loadingScreen.done') && !!window.geoaiDrivePlayer,
                  ready:!!window.geoaiDrivePlayer?.ready,
                  open:!!window.geoaiDrivePlayer?.isOpen,
                  playing:!!window.geoaiDrivePlayer?.playing,
                  distance:window.geoaiDrivePlayer?.distance || 0,
                  total:window.geoaiDrivePlayer?.route?.distance || 0,
                  speed:window.geoaiDrivePlayer?.speed || 1,
                  car:window.geoaiDrivePlayer?.vehicle?.getLatLng(),
                  reached:document.querySelectorAll('.video-distress-reached').length,
                  embedded:!!document.querySelector('#driveInspector #driveReplayHost #driveReplayPanel'),
                  frames:document.querySelector('.drive-replay-frame-heading .drive-inspector-count')?.textContent || '',
                  frame:document.querySelector('.drive-replay-frame-caption')?.textContent || '',
                  photo:Array.from(document.querySelectorAll('.drive-replay-frame-image img')).some(function(img){return img.complete && img.naturalWidth > 0;}),
                  expanded:document.querySelector('#driveFrameDetails')?.hidden === false,
                  inlineLabels:document.querySelector('#driveFrameDetails')?.textContent || '',
                  modal:!!document.querySelector('#cardStack .detail-panel.open'),
                  totalLabel:document.getElementById('videoDistanceLabel')?.textContent || ''
                })
            """.trimIndent()
            awaitState(scenario, stateScript) { it.optBoolean("loaded") }
            evaluate(scenario, """
                if (!window.geoaiVideoPaths.enabled) document.getElementById('videoToggle').click();
                document.getElementById('videoDriveReplay').click(); true
            """.trimIndent())
            val initial = awaitState(scenario, stateScript) { it.optBoolean("ready") && it.optBoolean("open") && it.optDouble("total") > 0 && it.optString("frames") == "230" }
            assertEquals(0.0, initial.getDouble("distance"), .01)
            evaluate(scenario, """
                var speed = document.querySelector('select[aria-label="Replay speed"]');
                speed.value = '16'; speed.dispatchEvent(new Event('change'));
                document.querySelector('.drive-replay-play').click(); true
            """.trimIndent())
            val moving = awaitState(scenario, stateScript) { it.optBoolean("playing") && it.optDouble("distance") > 1 }
            assertEquals(16, moving.getInt("speed"))
            assertNotEquals("The car must move with progress", initial.getJSONObject("car").toString(), moving.getJSONObject("car").toString())

            evaluate(scenario, """
                var scrub = document.querySelector('input[aria-label="Distance along drive"]');
                scrub.value = String(Number(scrub.max) / 2); scrub.dispatchEvent(new Event('input')); true
            """.trimIndent())
            val halfway = awaitState(scenario, stateScript) { !it.optBoolean("playing") && it.optDouble("distance") >= it.optDouble("total") / 2 - .1 }
            assertEquals("Scrubbing must seek to the recorded distance", halfway.getDouble("total") / 2, halfway.getDouble("distance"), .11)
            assertTrue("Reached distress camera badges missing", halfway.getInt("reached") > 0)
            assertTrue("Replay must live inside the drive inspector", halfway.optBoolean("embedded"))
            assertEquals("All stored frames must be available", "230", halfway.optString("frames"))
            assertEquals("Replay must keep the total for all drives", "4.06 km travelled", halfway.optString("totalLabel"))
            evaluate(scenario, """
                document.querySelector('[aria-label="Frame 2 · 7 m · Bleeding · Edge Cracking"]').click();
                document.querySelector('[aria-label="Show captured frame details"]').click(); true
            """.trimIndent())
            val details = awaitState(scenario, stateScript) {
                it.optBoolean("expanded") && it.optBoolean("photo") && !it.optBoolean("playing") && it.optString("frame").startsWith("Frame 2")
            }
            assertFalse("Frame details must not open a separate modal", details.optBoolean("modal"))
            assertTrue("Inline distress details missing", details.optString("inlineLabels").contains("Bleeding"))
            evaluate(scenario, "document.querySelector('[aria-label=\"Next captured frame\"]').click(); true")
            val next = awaitState(scenario, stateScript) { it.optString("frame").startsWith("Frame 3") && it.optBoolean("photo") }
            assertTrue("Next must keep the detail card open", next.optBoolean("expanded"))
            assertFalse("Next must not create an awkward second card", next.optBoolean("modal"))
            evaluate(scenario, """
                var normalSpeed = document.querySelector('select[aria-label="Replay speed"]');
                normalSpeed.value = '1'; normalSpeed.dispatchEvent(new Event('change'));
                document.querySelector('[aria-label="Play from this frame"]').click(); true
            """.trimIndent())
            val resumed = awaitState(scenario, stateScript) { it.optBoolean("playing") && it.optDouble("distance") > next.getDouble("distance") }
            assertTrue("Play must preserve the expanded details", resumed.optBoolean("expanded"))

            // A native picker, app switch or screen lock must pause the RAF
            // replay. Returning to the activity must never resume it itself.
            scenario.moveToState(Lifecycle.State.CREATED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            val paused = awaitState(scenario, stateScript) { it.optBoolean("ready") && !it.optBoolean("playing") }
            Thread.sleep(350)
            val stillPaused = awaitState(scenario, stateScript) { !it.optBoolean("playing") }
            assertEquals("Background replay kept travelling", paused.getDouble("distance"), stillPaused.getDouble("distance"), .01)
            evaluate(scenario, "document.querySelector('[aria-label=\"Close route player\"]').click(); true")
            val closed = awaitState(scenario, stateScript) { !it.optBoolean("open") }
            assertFalse(closed.optBoolean("playing"))
            println("Android replay verified: embedded player, all 230 stored frames, moving car, 16x speed, halfway scrub, persistent photo details, Next and Play, native pause/resume, close")
        }
    }

    private fun awaitPageLoad(scenario: ActivityScenario<SurveyActivity>) {
        // Source changes navigate the WebView. Wait for the native completion
        // indicator before evaluating JavaScript in the replacement document;
        // callbacks submitted to the outgoing document can be discarded.
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
        do {
            var loaded = false
            scenario.onActivity { activity ->
                assertEquals("The replacement dashboard failed to load", View.GONE,
                    activity.findViewById<View>(R.id.surveyMessagePanel).visibility)
                loaded = activity.findViewById<View>(R.id.surveyProgress).visibility == View.GONE
            }
            if (loaded) return
            Thread.sleep(150)
        } while (System.nanoTime() < deadline)
        fail("Replacement dashboard did not finish loading")
    }

    private fun evaluate(scenario: ActivityScenario<SurveyActivity>, script: String): String {
        val latch = CountDownLatch(1)
        val result = AtomicReference<String>("")
        scenario.onActivity { activity ->
            activity.findViewById<WebView>(R.id.surveyWebView).evaluateJavascript(script) { value -> result.set(value); latch.countDown() }
        }
        // Software-rendered emulator WebGL startup may occupy its renderer
        // for several seconds. The full state wait remains bounded separately.
        assertTrue("WebView did not respond", latch.await(20, TimeUnit.SECONDS))
        return result.get()
    }

    private fun awaitNativeFeedback(scenario: ActivityScenario<SurveyActivity>, message: Int) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        var shown = false
        do {
            scenario.onActivity { activity ->
                val label = activity.findViewById<TextView>(R.id.surveyFeedback)
                shown = label.visibility == View.VISIBLE && label.text.toString() == activity.getString(message)
            }
            if (shown) return
            Thread.sleep(50)
        } while (System.nanoTime() < deadline)
        assertTrue("Native export rejection was silent", shown)
    }

    private fun awaitState(scenario: ActivityScenario<SurveyActivity>, script: String, matches: (JSONObject) -> Boolean): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(75)
        var state = JSONObject()
        do {
            val value = JSONTokener(evaluate(scenario, script)).nextValue()
            if (value is String) state = JSONObject(value)
            if (matches(state)) return state
            Thread.sleep(150)
        } while (System.nanoTime() < deadline)
        fail("Survey state did not settle: $state")
        return state
    }
}
