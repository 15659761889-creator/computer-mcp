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
                    setRequestProperty("X-App-Lang", Lang.code)
                    outputStream.use { it.write(JSONObject().put("code", code).toString().toByteArray()) }
                }
            } catch (_: IOException) {
                throw HubException(tr("连不上服务器，请检查手机网络", "Can’t reach the server. Check your phone’s network"))
            }
            try {
                val status = try {
                    http.responseCode
                } catch (_: IOException) {
                    throw HubException(tr("连不上服务器，请检查手机网络", "Can’t reach the server. Check your phone’s network"))
                }
                val stream = if (status in 200..299) http.inputStream else http.errorStream
                val json = try {
                    JSONObject(stream?.bufferedReader()?.use { it.readText() }.orEmpty().ifEmpty { "{}" })
                } catch (_: Exception) {
                    JSONObject()
                }
                if (status !in 200..299) throw HubException(json.optString("error", tr("邀请无效（$status）", "Invalid invite ($status)")))
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
    /** Has the AI's own headless browser, which the phone can take over too. */
    val browser: Boolean = false,
    /** Title of the browser the AI asked the person to take over, or null. */
    val takeover: String?,
    /** How it reaches the main computer: auto, lan or public. */
    val route: String = "auto",
    /** The path it uses right now, lan or public; null when offline or the main computer. */
    val via: String? = null,
    /** Why the LAN does not work for it, or null. */
    val lanProblem: String? = null,
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

data class HubStatus(
    val full: String,
    val address: String,
    val key: String,
    val computers: List<Computer>,
    val secretRequests: List<SecretRequest> = emptyList(),
    val version: Int = 0,
)

data class Invite(val pair: String, val minutes: Int)


data class McpTool(
    val name: String,
    val title: String,
    val description: String,
)

data class ClientToken(
    val id: String,
    val name: String,
    val tools: List<String>,
    val createdAt: String,
)

data class ClientTokenView(val tokens: List<ClientToken>, val tools: List<McpTool>)
data class IssuedClientToken(val token: ClientToken, val key: String)

/** One note in the shared memory. owner: the owner wrote its latest version. */
data class MemoryNote(
    val displayText: String,
    val stateEvidence: String?,
    val id: String,
    val kind: String,
    val key: String?,
    val text: String,
    val computer: String?,
    val author: String,
    val owner: Boolean,
    val locked: Boolean,
    val updated: String,
    val via: String?,
)

/** Who has written to the memory: the name an AI gave, and where its calls came from. */
data class MemoryAuthor(val author: String, val writes: Int, val last: String, val via: List<String>)

data class MemoryView(val notes: List<MemoryNote>, val authors: List<MemoryAuthor>, val chars: Int)

/** The main computer's management API. Every call blocks, so run it off the main thread. */
class HubClient(private val connection: Connection) {
    private fun request(method: String, path: String, body: JSONObject? = null, readTimeoutMs: Int = 15000): JSONObject {
        val http = try {
            (URL("https://${connection.host}/hub/api/$path").openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15000
                readTimeout = readTimeoutMs
                setRequestProperty("Authorization", "Bearer ${connection.key}")
                setRequestProperty("X-App-Lang", Lang.code)
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
            if (status == 401) throw HubException(tr("连接已失效，请重新扫描主电脑上的二维码", "The connection has expired. Scan the QR code on the main computer again"), unauthorized = true)
            // Without the hub the address answers 404, and a stopped tunnel answers 5xx.
            if (status == 404 && path == "status") throw HubException(tr("这个地址还不是主电脑，请在电脑上重新生成二维码", "This address isn’t a main computer yet. Generate the QR code again on the computer"))
            if (status >= 500) throw HubException(UNREACHABLE)
            val stream = if (status in 200..299) http.inputStream else http.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = try {
                JSONObject(text.ifEmpty { "{}" })
            } catch (_: Exception) {
                throw HubException(UNREACHABLE)
            }
            if (status !in 200..299) throw HubException(json.optString("error", tr("主电脑返回了错误（$status）", "The main computer returned an error ($status)")))
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
        return HubStatus(
            version = json.optInt("version"),
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
                    browser = c.optBoolean("browser"),
                    takeover = c.optJSONObject("takeover")?.optString("title"),
                    route = c.optString("route", "auto").ifEmpty { "auto" },
                    via = if (c.isNull("via")) null else c.optString("via").ifEmpty { null },
                    lanProblem = if (c.isNull("lanProblem")) null else c.optString("lanProblem").ifEmpty { null },
                )
            },
        )
    }


    fun clientTokens(): ClientTokenView {
        val toolArray = request("GET", "token-tools").getJSONArray("tools")
        val tokensArray = request("GET", "tokens").getJSONArray("tokens")
        val tools = List(toolArray.length()) { index ->
            val item = toolArray.getJSONObject(index)
            McpTool(item.getString("name"), item.optString("title", item.getString("name")), item.optString("description"))
        }
        val tokens = List(tokensArray.length()) { index ->
            val item = tokensArray.getJSONObject(index)
            val allowed = item.optJSONArray("tools")
            ClientToken(
                id = item.getString("id"),
                name = item.optString("name"),
                tools = List(allowed?.length() ?: 0) { allowed!!.getString(it) },
                createdAt = item.optString("createdAt"),
            )
        }
        return ClientTokenView(tokens, tools)
    }

    fun createClientToken(name: String, tools: List<String>): IssuedClientToken {
        val list = org.json.JSONArray()
        tools.forEach { list.put(it) }
        val json = request("POST", "tokens", JSONObject().put("name", name).put("tools", list))
        val item = json.getJSONObject("token")
        val allowed = item.getJSONArray("tools")
        return IssuedClientToken(
            ClientToken(item.getString("id"), item.getString("name"), List(allowed.length()) { allowed.getString(it) }, item.optString("createdAt")),
            json.getString("key"),
        )
    }

    fun updateClientToken(id: String, name: String, tools: List<String>) {
        val list = org.json.JSONArray()
        tools.forEach { list.put(it) }
        request("POST", "tokens/$id", JSONObject().put("name", name).put("tools", list))
    }

    fun deleteClientToken(id: String) {
        request("DELETE", "tokens/$id")
    }

    fun activityFeed(): JSONObject = request("GET", "activity")

    fun memory(): MemoryView {
        val json = try {
            request("GET", "memory")
        } catch (error: HubException) {
            if (error.message == "not found") throw HubException(tr("主电脑的 Computer MCP 版本太旧，还没有共享记忆，请先升级", "The main computer’s Computer MCP is too old and has no shared memory yet. Please upgrade it first"))
            throw error
        }
        val notes = json.getJSONArray("notes")
        val authors = json.getJSONArray("authors")
        fun JSONObject.text(name: String) = if (isNull(name)) null else optString(name).ifEmpty { null }
        return MemoryView(
            notes = List(notes.length()) { index ->
                val n = notes.getJSONObject(index)
                MemoryNote(
                    displayText = n.optString("display_text", n.optString("text")),
                    stateEvidence = n.optJSONObject("state")?.toString(2),
                    id = n.getString("id"),
                    kind = n.optString("kind"),
                    key = n.text("key"),
                    text = n.optString("text"),
                    computer = n.text("computer"),
                    author = n.optString("author"),
                    owner = n.optBoolean("owner"),
                    locked = n.optBoolean("locked"),
                    updated = n.optString("updated"),
                    via = n.text("via"),
                )
            },
            authors = List(authors.length()) { index ->
                val a = authors.getJSONObject(index)
                val via = a.optJSONArray("via")
                MemoryAuthor(a.optString("author"), a.optInt("events"), a.optString("last"), List(via?.length() ?: 0) { via!!.optString(it) })
            },
            chars = json.optJSONObject("stats")?.optInt("chars") ?: 0,
        )
    }

    /** Saves a note as the owner; locked notes cannot be changed or deleted by any AI. */
    fun memoryAdd(key: String, text: String, computer: String?, locked: Boolean) {
        val body = JSONObject().put("kind", "fact").put("key", key).put("text", text).put("locked", locked)
        if (!computer.isNullOrBlank()) body.put("computer", computer)
        request("POST", "memory/add", body)
    }

    /** Deletes a note and wipes its text from the computer's disk. */
    fun memoryForget(id: String) {
        request("POST", "memory/forget", JSONObject().put("id", id))
    }

    fun memoryLock(id: String, locked: Boolean) {
        request("POST", "memory/lock", JSONObject().put("id", id).put("locked", locked))
    }

    /** Undoes one AI's writes (author), or every AI's writes since sinceMs (author null). Returns how many. */
    fun memoryRevoke(author: String?, sinceMs: Long?): Int {
        val body = if (author != null) JSONObject().put("author", author) else JSONObject().put("all", true).put("since", sinceMs ?: 0L)
        return request("POST", "memory/revoke", body).optInt("events")
    }

    fun invite(): Invite {
        val json = request("POST", "invites")
        return Invite(json.getString("pair"), json.optInt("expiresIn", 600) / 60)
    }

    fun update(id: String, name: String?, note: String) {
        val body = JSONObject().put("note", note)
        if (name != null) body.put("name", name)
        request("POST", "computers/$id", body)
    }

    fun setRoute(id: String, route: String) {
        request("POST", "computers/$id", JSONObject().put("route", route))
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
                setRequestProperty("X-App-Lang", Lang.code)
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
            if (status == 401) throw HubException(tr("连接已失效，请重新扫码", "The connection has expired. Please scan again"), unauthorized = true)
            if (status != 200) {
                val text = http.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val json = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
                throw HubException(json.optString("error").ifEmpty { tr("取不到画面（$status）", "Couldn’t get the picture ($status)") }, needsPick = json.optBoolean("pick"))
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
        val UNREACHABLE: String get() = tr("连不上主电脑。请确认主电脑已开机联网，手机网络正常", "Can’t reach the main computer. Make sure it is on and online, and your phone’s network is working")
    }
}
