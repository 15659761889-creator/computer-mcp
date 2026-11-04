package com.computermcp.app

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** host is a domain or IPv4 address, with :port when not 443. */
data class Connection(val host: String, val key: String) {
    companion object {
        private val HOST = Regex("^((?:[a-z0-9-]+\\.)+[a-z]{2,63}|\\d{1,3}(?:\\.\\d{1,3}){3})(:\\d{2,5})?$")
        private val KEY = Regex("^[A-Za-z0-9_-]{16,}$")

        private fun split(text: String): Pair<String, String>? {
            val uri = Uri.parse(text.trim())
            if (uri.scheme != "computermcp") return null
            val host = uri.encodedAuthority?.lowercase() ?: return null
            val path = uri.path?.trim('/') ?: return null
            return if (HOST.matches(host)) host to path else null
        }

        /** The QR code of your own main computer or server: computermcp://host/key */
        fun parse(text: String): Connection? {
            val (host, key) = split(text) ?: return null
            return if (KEY.matches(key)) Connection(host, key) else null
        }

        /** An invite to someone else's relay: computermcp://host/signup/code */
        fun parseInvite(text: String): Pair<String, String>? {
            val (host, path) = split(text) ?: return null
            val code = path.removePrefix("signup/")
            return if (path.startsWith("signup/") && KEY.matches(code)) host to code else null
        }

        /** Turns an invite into this phone's own connection. Blocks, so run it off the main thread. */
        fun signUp(host: String, code: String): Connection {
            val http = try {
                (URL("https://$host/relay/signup").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 15000
                    readTimeout = 15000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    outputStream.use { it.write(JSONObject().put("code", code).toString().toByteArray()) }
                }
            } catch (_: IOException) {
                throw HubException("连不上服务器，请检查手机网络")
            }
            try {
                val status = try {
                    http.responseCode
                } catch (_: IOException) {
                    throw HubException("连不上服务器，请检查手机网络")
                }
                val stream = if (status in 200..299) http.inputStream else http.errorStream
                val json = try {
                    JSONObject(stream?.bufferedReader()?.use { it.readText() }.orEmpty().ifEmpty { "{}" })
                } catch (_: Exception) {
                    JSONObject()
                }
                if (status !in 200..299) throw HubException(json.optString("error", "邀请无效（$status）"))
                return Connection(host, json.getString("adminKey"))
            } finally {
                http.disconnect()
            }
        }
    }
}

/** Keeps the connection in app storage, encrypted with a key held by the Android keystore. */
class ConnectionStore(context: Context) {
    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    fun load(): Connection? {
        val host = prefs.getString("host", null) ?: return null
        val sealed = prefs.getString("key", null) ?: return null
        val iv = prefs.getString("iv", null) ?: return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            Connection(host, String(cipher.doFinal(Base64.decode(sealed, Base64.NO_WRAP))))
        } catch (_: Exception) {
            null
        }
    }

    fun save(connection: Connection) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        prefs.edit()
            .putString("host", connection.host)
            .putString("key", Base64.encodeToString(cipher.doFinal(connection.key.toByteArray()), Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    fun clear() = prefs.edit().clear().apply()

    private companion object {
        const val ALIAS = "computer-mcp-connection"
    }
}

class HubException(message: String, val unauthorized: Boolean = false, val needsPick: Boolean = false) : Exception(message)

data class Computer(
    val id: String,
    val name: String,
    val note: String,
    val online: Boolean,
    val main: Boolean,
    val os: String,
    val desktop: Boolean,
    /** Title of the browser the AI asked the person to take over, or null. */
    val takeover: String?,
)

class BrowserFrame(val jpeg: ByteArray, val title: String)

/** A browser window on a computer. automation marks one a program drives, such as the AI's own browser. */
data class BrowserWindow(val hwnd: Long, val title: String, val automation: Boolean, val minimized: Boolean)

/** The AI wants to type a saved account on a computer and waits for the person to pick one. */
data class SecretRequest(
    val id: String,
    val computer: String,
    val hint: String,
    val part: String,
    val reason: String,
    val where: String,
)

/** Something in the AI chat pool the owner should know about: a question, a conclusion, a stuck discussion. */
data class PoolAlert(val key: String, val title: String, val text: String, val topicId: Int?)

data class HubStatus(
    val full: String,
    val address: String,
    val key: String,
    val computers: List<Computer>,
    val secretRequests: List<SecretRequest> = emptyList(),
    val version: Int = 0,
    val poolAlerts: List<PoolAlert> = emptyList(),
)

data class Invite(val pair: String, val minutes: Int)

/** The main computer's management API. Every call blocks, so run it off the main thread. */
class HubClient(private val connection: Connection) {
    private fun request(method: String, path: String, body: JSONObject? = null, readTimeoutMs: Int = 15000): JSONObject {
        val http = try {
            (URL("https://${connection.host}/hub/api/$path").openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15000
                readTimeout = readTimeoutMs
                setRequestProperty("Authorization", "Bearer ${connection.key}")
                setRequestProperty("Content-Type", "application/json")
                if (body != null) {
                    doOutput = true
                    outputStream.use { it.write(body.toString().toByteArray()) }
                }
            }
        } catch (_: IOException) {
            throw HubException(UNREACHABLE)
        }
        try {
            val status = try {
                http.responseCode
            } catch (_: IOException) {
                throw HubException(UNREACHABLE)
            }
            if (status == 401) throw HubException("连接已失效，请重新扫描主电脑上的二维码", unauthorized = true)
            // Without the hub the address answers 404, and a stopped tunnel answers 5xx.
            if (status == 404 && path == "status") throw HubException("这个地址还不是主电脑，请在电脑上重新生成二维码")
            // The pool answers 503 with its own reason (for example an old Node.js on the main computer).
            if (status >= 500 && !(status == 503 && path.startsWith("pool"))) throw HubException(UNREACHABLE)
            val stream = if (status in 200..299) http.inputStream else http.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = try {
                JSONObject(text.ifEmpty { "{}" })
            } catch (_: Exception) {
                throw HubException(UNREACHABLE)
            }
            if (status !in 200..299) throw HubException(json.optString("error", "主电脑返回了错误（$status）"))
            return json
        } finally {
            http.disconnect()
        }
    }

    fun status(): HubStatus {
        val json = request("GET", "status")
        val mcp = json.getJSONObject("mcp")
        val list = json.getJSONArray("computers")
        val secrets = json.optJSONArray("secretRequests")
        val alerts = json.optJSONArray("poolAlerts")
        return HubStatus(
            version = json.optInt("version"),
            poolAlerts = List(alerts?.length() ?: 0) { index ->
                val a = alerts!!.getJSONObject(index)
                PoolAlert(a.optString("key"), a.optString("title"), a.optString("text"), if (a.isNull("topic_id")) null else a.optInt("topic_id"))
            },
            secretRequests = List(secrets?.length() ?: 0) { index ->
                val r = secrets!!.getJSONObject(index)
                SecretRequest(r.getString("id"), r.optString("computer"), r.optString("hint"), r.optString("part"), r.optString("reason"), r.optString("where"))
            },
            full = mcp.getString("full"),
            address = mcp.getString("address"),
            key = mcp.getString("key"),
            computers = List(list.length()) { index ->
                val c = list.getJSONObject(index)
                Computer(
                    id = c.getString("id"),
                    name = c.getString("name"),
                    note = c.optString("note"),
                    online = c.optBoolean("online"),
                    main = c.optBoolean("main"),
                    os = c.optString("os"),
                    desktop = c.optBoolean("desktop"),
                    takeover = c.optJSONObject("takeover")?.optString("title"),
                )
            },
        )
    }

    fun activityFeed(): JSONObject = request("GET", "activity")

    /** Read the one shared AI message pool through the existing admin-authenticated API. */
    fun poolFeed(): JSONObject = request("GET", "pool?limit=60")

    /** One discussion with its latest messages, oldest first. */
    fun poolTopic(topicId: Int): JSONObject = request("GET", "pool?topic=$topicId&limit=100")

    fun startTopic(title: String, goal: String): JSONObject =
        request("POST", "pool/topics", JSONObject().put("title", title).put("goal", goal)).getJSONObject("topic")

    /** The owner's own message, in a discussion or in the general stream. */
    fun postToPool(content: String, topicId: Int?, replyTo: Int? = null): JSONObject {
        val body = JSONObject().put("content", content)
        if (topicId != null) body.put("topic_id", topicId)
        if (replyTo != null) body.put("reply_to", replyTo)
        return request("POST", "pool/messages", body)
    }

    fun concludeTopic(topicId: Int, conclusion: String): JSONObject =
        request("POST", "pool/topics/$topicId/conclude", JSONObject().put("conclusion", conclusion)).getJSONObject("topic")

    fun reopenTopic(topicId: Int): JSONObject = request("POST", "pool/topics/$topicId/reopen").getJSONObject("topic")

    fun invite(): Invite {
        val json = request("POST", "invites")
        return Invite(json.getString("pair"), json.optInt("expiresIn", 600) / 60)
    }

    fun update(id: String, name: String?, note: String) {
        val body = JSONObject().put("note", note)
        if (name != null) body.put("name", name)
        request("POST", "computers/$id", body)
    }

    fun remove(id: String) {
        request("DELETE", "computers/$id")
    }

    /** One JPEG of the computer's browser window. The first call picks the browser and brings it forward. */
    fun browserFrame(id: String): BrowserFrame {
        val http = try {
            (URL("https://${connection.host}/hub/api/computers/$id/browser/frame").openConnection() as HttpURLConnection).apply {
                connectTimeout = 15000
                readTimeout = 30000
                setRequestProperty("Authorization", "Bearer ${connection.key}")
            }
        } catch (_: IOException) {
            throw HubException(UNREACHABLE)
        }
        try {
            val status = try {
                http.responseCode
            } catch (_: IOException) {
                throw HubException(UNREACHABLE)
            }
            if (status == 401) throw HubException("连接已失效，请重新扫码", unauthorized = true)
            if (status != 200) {
                val text = http.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val json = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
                throw HubException(json.optString("error").ifEmpty { "取不到画面（$status）" }, needsPick = json.optBoolean("pick"))
            }
            val title = Uri.decode(http.getHeaderField("X-Window-Title").orEmpty())
            return BrowserFrame(http.inputStream.use { it.readBytes() }, title)
        } catch (_: IOException) {
            throw HubException(UNREACHABLE)
        } finally {
            http.disconnect()
        }
    }

    fun browserInput(id: String, action: JSONObject) {
        request("POST", "computers/$id/browser/input", action)
    }

    fun browserWindows(id: String): List<BrowserWindow> {
        val list = request("GET", "computers/$id/browser/windows", readTimeoutMs = 30000).getJSONArray("windows")
        return List(list.length()) { index ->
            val w = list.getJSONObject(index)
            BrowserWindow(w.getLong("hwnd"), w.optString("title"), w.optBoolean("automation"), w.optBoolean("minimized"))
        }
    }

    /** Picks the window to show and brings it to the front of that computer's screen. */
    fun browserSelect(id: String, hwnd: Long) {
        request("POST", "computers/$id/browser/select", JSONObject().put("hwnd", hwnd), readTimeoutMs = 30000)
    }

    /** Brings the browser to the front again, for when another window covered it. */
    fun browserStart(id: String) {
        request("POST", "computers/$id/browser/start", JSONObject())
    }

    /** Blocks until something changes on the hub (up to about 25 seconds) and returns its new version. */
    fun waitForEvent(since: Int): Int = request("GET", "wait?since=$since", readTimeoutMs = 45000).optInt("version")

    /** Sends the chosen account for one request, or declines it when entry is null. */
    fun answerSecret(id: String, entry: VaultEntry?) {
        val body = JSONObject().put("approve", entry != null)
        if (entry != null) body.put("label", entry.label).put("username", entry.username).put("password", entry.password)
        request("POST", "secrets/$id", body)
    }

    /** Hands the desktop back to the AI. */
    fun browserFinish(id: String) {
        request("POST", "computers/$id/browser/finish", JSONObject())
    }

    private companion object {
        const val UNREACHABLE = "连不上主电脑。请确认主电脑已开机联网，手机网络正常"
    }
}
