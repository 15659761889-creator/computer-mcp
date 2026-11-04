package com.computermcp.app

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.integration.android.IntentIntegrator
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

private const val BLUE = 0xFF2563EB.toInt()
private const val INK = 0xFF1F2937.toInt()
private const val MUTED = 0xFF6B7280.toInt()
private const val PAGE = 0xFFF3F4F6.toInt()
private const val GREEN = 0xFF16A34A.toInt()
private const val GRAY = 0xFF9CA3AF.toInt()
private const val REFRESH_MS = 5000L
private const val ACTIVITY_REFRESH_MS = 2000L
private const val ORANGE = 0xFFEA580C.toInt()
private const val NIGHT = 0xFF0B0F17.toInt()
private const val PREVIEW_MS = 2500L

class MainActivity : Activity() {
    private val background = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var store: ConnectionStore
    private var connection: Connection? = null
    private var client: HubClient? = null

    private var computersBox: LinearLayout? = null
    private var activityBox: LinearLayout? = null
    private var activityNotice: TextView? = null
    private var activityShown: String? = null
    private var activityLoadingToken = -1
    private var poolBox: LinearLayout? = null
    private var poolError: TextView? = null
    private var poolShown: String? = null
    private var poolLoadingToken = -1
    private var poolButton: Button? = null
    private var topicBox: LinearLayout? = null
    private var topicScroll: ScrollView? = null
    private var topicInput: EditText? = null
    private var topicSend: Button? = null
    private var topicShown: String? = null
    private var currentTopic = 0
    private var errorLine: TextView? = null
    private var status: HubStatus? = null
    private var shownComputers: Any? = null
    private lateinit var vault: VaultStore
    private var knownIds: Set<String>? = null
    private var pairDialog: AlertDialog? = null
    /** Bumped on every screen change, so loops started for an old screen stop. */
    private var screenToken = 0
    private var backTo: (() -> Unit)? = null
    private val announcedTakeovers = mutableSetOf<String>()

    private val refresher = object : Runnable {
        override fun run() {
            when {
                activityBox != null -> refreshActivity()
                topicBox != null -> refreshTopic()
                poolBox != null -> refreshPool()
                else -> refresh()
            }
            main.postDelayed(this, if (activityBox != null) ACTIVITY_REFRESH_MS else REFRESH_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ConnectionStore(this)
        vault = VaultStore(this)
        connection = store.load()
        client = connection?.let { HubClient(it) }
        if (connection == null) showWelcome() else showHome()
        if (connection != null) ensurePush()
        handleLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    override fun onResume() {
        super.onResume()
        if (client != null) main.post(refresher)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val back = backTo
        if (back != null) back() else super.onBackPressed()
    }

    override fun onPause() {
        super.onPause()
        main.removeCallbacks(refresher)
    }

    // Another app can send this link, so the person confirms before the phone trusts that address.
    private fun handleLink(intent: Intent?) {
        val topic = intent?.getIntExtra(EXTRA_TOPIC, 0) ?: 0
        if (topic > 0 && client != null) {
            intent?.removeExtra(EXTRA_TOPIC)
            showTopic(topic)
            return
        }
        val text = intent?.dataString ?: return
        intent.data = null
        Connection.parseInvite(text)?.let { (host, code) ->
            AlertDialog.Builder(this)
                .setTitle("使用这个中转服务？")
                .setMessage("服务器：$host\n\nAI 的指令和电脑返回的结果会经过这台服务器。只接受你信任的人给的邀请。")
                .setPositiveButton("接受") { _, _ -> acceptInvite(host, code) }
                .setNegativeButton("取消", null)
                .show()
            return
        }
        val parsed = Connection.parse(text) ?: return
        AlertDialog.Builder(this)
            .setTitle("连接这台服务器？")
            .setMessage("地址：${parsed.host}\n\n只连接你自己的电脑或服务器。")
            .setPositiveButton("连接") { _, _ -> connect(parsed) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun acceptInvite(host: String, code: String) {
        if (connection != null) {
            toast("请先点右上角“断开”，再接受新的邀请")
            return
        }
        toast("正在加入…")
        work({ Connection.signUp(host, code) }, { error -> toast(error.message ?: "加入失败") }) { connect(it) }
    }

    private fun accept(text: String) {
        val invite = Connection.parseInvite(text)
        val own = Connection.parse(text)
        when {
            invite != null -> acceptInvite(invite.first, invite.second)
            own != null -> connect(own)
            else -> toast("这不是 Computer MCP 的二维码或邀请")
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (scan == null) {
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        accept(scan.contents ?: return)
    }

    // ---- First screen ----

    private fun showWelcome() {
        computersBox = null
        val page = page()
        page.addView(text("Computer MCP", 28f, INK, bold = true))
        page.addView(text("一个地址，让 AI 控制你所有的电脑", 15f, MUTED).below(6))

        val steps = card().below(28)
        steps.addView(text("怎么开始", 17f, INK, bold = true))
        steps.addView(text("1. 找到二维码：自己租的服务器装好后会显示一个；常开电脑在 Computer MCP 里点“连接手机 App”；用别人的服务，就用他给你的邀请", 15f, INK).below(12))
        steps.addView(text("2. 用下面的按钮扫码", 15f, INK).below(8))
        steps.addView(text("3. 添加电脑，再把地址填进豆包、ChatGPT 等 AI 软件", 15f, INK).below(8))
        page.addView(steps)

        page.addView(primary("扫码连接") { scan() }.below(24))
        page.addView(secondary("扫不了？粘贴连接文本") { askForText() }.below(10))
    }

    private fun scan() {
        IntentIntegrator(this)
            .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
            .setPrompt("对准电脑上的二维码")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
            .initiateScan()
    }

    private fun askForText() {
        val input = EditText(this).apply { hint = "computermcp://…" }
        AlertDialog.Builder(this)
            .setTitle("粘贴连接文本或邀请")
            .setView(padded(input))
            .setPositiveButton("连接") { _, _ -> accept(input.text.toString()) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun connect(next: Connection) {
        val candidate = HubClient(next)
        toast("正在连接…")
        work({ candidate.status() }, { error -> toast(error.message ?: "连接失败") }) { fresh ->
            store.save(next)
            connection = next
            client = candidate
            status = fresh
            knownIds = fresh.computers.map { it.id }.toSet()
            showHome()
            main.removeCallbacks(refresher)
            main.post(refresher)
            ensurePush()
        }
    }

    // ---- Main screen ----

    private fun showHome() {
        shownComputers = null
        val page = page()

        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(text("我的电脑", 26f, INK, bold = true), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        header.addView(text("断开", 14f, MUTED).apply {
            setPadding(dp(12), dp(8), 0, dp(8))
            setOnClickListener { confirmForget() }
        })
        page.addView(header)

        errorLine = text("", 14f, 0xFFB91C1C.toInt()).apply { visibility = View.GONE }.below(8)
        page.addView(errorLine)

        val mcp = card().below(16)
        mcp.addView(text("统一 MCP 地址", 17f, INK, bold = true))
        mcp.addView(text("粘贴到豆包、ChatGPT、Claude 等 AI 软件。所有电脑都用这一个地址。", 14f, MUTED).below(6))
        mcp.addView(primary("复制 MCP 地址") { copyPart("MCP 地址") { it.full } }.below(14))
        val parts = LinearLayout(this)
        parts.addView(secondary("只复制网址") { copyPart("网址") { it.address } }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(8) })
        parts.addView(secondary("只复制密钥") { copyPart("密钥") { it.key } }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        mcp.addView(parts.below(8))
        mcp.addView(text("如果 AI 软件要求分开填写网址和密钥，才用上面两个按钮。这个地址能控制你所有的电脑，不要发给别人。", 12f, MUTED).below(10))
        mcp.addView(text("怎么填进豆包、ChatGPT？", 14f, BLUE).apply {
            setPadding(0, dp(10), 0, dp(4))
            setOnClickListener { showClientHelp() }
        })
        page.addView(mcp)

        page.addView(text("电脑", 17f, INK, bold = true).below(24))
        computersBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        page.addView(computersBox)
        page.addView(primary("＋ 添加电脑") { addComputer() }.below(16))
        page.addView(secondary("AI 正在做什么") { showActivity() }.below(10))
        poolButton = secondary("💬 AI 公共聊天池") { showPool() }.below(10)
        page.addView(poolButton)

        val extras = card().below(24)
        extras.addView(text("密码库", 17f, INK, bold = true))
        extras.addView(text("账号密码只加密保存在这部手机上。AI 要登录时先问你，你选好账号，电脑上直接填好，AI 看不到密码。", 13f, MUTED).below(6))
        extras.addView(secondary("管理保存的账号（${vault.load().size}）") { showVault() }.below(10))
        extras.addView(text("后台提醒", 17f, INK, bold = true).below(20))
        val pushLine = text("", 14f, INK).below(6)
        fun paintPush() {
            pushLine.text = if (PushService.enabled(this)) "已开启：AI 需要你时会弹通知（点这里关闭）" else "已关闭：只有打开 App 才能看到 AI 的请求（点这里开启）"
        }
        paintPush()
        pushLine.setOnClickListener {
            PushService.setEnabled(this, !PushService.enabled(this))
            if (PushService.enabled(this)) ensurePush()
            paintPush()
        }
        extras.addView(pushLine)
        extras.addView(text("收不到通知时，在手机设置里允许 Computer MCP 自启动和后台运行（vivo、小米、华为等都要设置）。", 12f, MUTED).below(6))
        page.addView(extras)

        status?.let { render(it) }
    }

    private fun showActivity() {
        val page = page()
        backTo = { showHome() }
        page.addView(header("AI 正在做什么") { showHome() })
        page.addView(text("显示通过 Computer MCP 发出的工具调用，打开本页时自动更新。", 13f, MUTED).below(10))
        activityNotice = text("正在读取活动…", 13f, MUTED).below(10).also { page.addView(it) }
        activityBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also { page.addView(it) }
        activityShown = null
        main.removeCallbacks(refresher)
        main.post(refresher)
    }

    private fun refreshActivity() {
        val current = client ?: return
        val box = activityBox ?: return
        val token = screenToken
        if (activityLoadingToken == token) return
        activityLoadingToken = token
        work({ current.activityFeed() }, { error ->
            if (activityLoadingToken == token) activityLoadingToken = -1
            if (token != screenToken) return@work
            activityNotice?.apply {
                val reason = error.message
                text = if (reason == "not found") "当前主机版本不支持活动列表，请升级 Computer MCP 主机。"
                else "读取活动失败" + (if (reason.isNullOrBlank()) "，正在重试。" else "：$reason") +
                    (if (box.childCount > 0) "（下方为上次读取的记录）" else "")
                setTextColor(ORANGE)
                visibility = View.VISIBLE
            }
        }) { feed ->
            if (activityLoadingToken == token) activityLoadingToken = -1
            if (token != screenToken) return@work
            activityNotice?.visibility = View.GONE
            val signature = feed.toString()
            if (activityShown == signature) return@work
            activityShown = signature
            renderActivity(box, feed)
        }
    }

    private fun renderActivity(box: LinearLayout, feed: JSONObject) {
        box.removeAllViews()
        val active = feed.getJSONArray("active")
        val recent = feed.getJSONArray("recent")
        val clock = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())
        box.addView(text("进行中（${active.length()}）", 17f, INK, bold = true))
        if (active.length() == 0) {
            box.addView(text("当前没有进行中的工具调用。AI 可能在思考、等待回复或已经结束。", 14f, MUTED).below(8))
        }
        for (index in 0 until active.length()) {
            box.addView(activityCard(active.getJSONObject(index), clock))
        }
        box.addView(text("最近完成的调用", 17f, INK, bold = true).below(22))
        if (recent.length() == 0) box.addView(text("暂无记录", 14f, MUTED).below(8))
        for (index in 0 until recent.length()) {
            box.addView(activityCard(recent.getJSONObject(index), clock))
        }
    }

    private fun activityCard(entry: JSONObject, clock: SimpleDateFormat): LinearLayout {
        val action = when (entry.getString("action")) {
            "list_computers" -> "查看电脑列表"
            "search" -> "搜索文件或内容"
            "list_files" -> "查看文件列表"
            "bash" -> "运行命令"
            "job" -> "管理电脑任务"
            "read_file" -> "读取文件"
            "write_file" -> "写入文件"
            "edit_file" -> "编辑文件"
            "ui_look" -> "查看电脑屏幕"
            "ui_act" -> "操作电脑界面"
            "type_secret" -> "请求使用已保存的账号"
            "request_human_takeover" -> "请求手机接管"
            "check_human_takeover" -> "查看接管状态"
            "cancel_human_takeover" -> "结束接管"
            "pool_join" -> "加入 AI 聊天池"
            "pool_topic" -> "管理 AI 讨论"
            "pool_read" -> "读取 AI 聊天池"
            "pool_wait" -> "等待 AI 聊天池回复"
            "pool_post" -> "在 AI 聊天池发言"
            "pool_ack" -> "确认 AI 聊天池消息"
            else -> "调用工具"
        }
        val (status, color) = when (entry.optString("status")) {
            "succeeded" -> "成功" to GREEN
            "failed" -> "失败" to ORANGE
            "background" -> "已交给后台任务，结果待确认" to ORANGE
            "unknown" -> "结果未知" to ORANGE
            else -> "调用进行中" to BLUE
        }
        val computer = if (entry.isNull("computer")) "" else " · ${entry.getString("computer")}"
        val time = clock.format(Date(entry.getLong("startedAt")))
        val duration = entry.optLong("durationMs", -1)
        val elapsed = when {
            duration < 0 -> ""
            duration < 1000 -> " · ${duration} 毫秒"
            else -> " · " + String.format(Locale.getDefault(), "%.1f 秒", duration / 1000.0)
        }
        return card().apply {
            addView(text(action + computer, 15f, INK, bold = true))
            addView(text(time + elapsed, 13f, MUTED).below(6))
            addView(text(status, 13f, color).below(4))
        }.below(10)
    }

    // ---- Public AI message pool ----
    private fun showPool() {
        val page = page()
        backTo = { showHome() }
        page.addView(header("AI 公共聊天池") { showHome() })
        page.addView(text("AI 们在这里互相讨论、商量方案。发起一个讨论后，把邀请语分别发给 ChatGPT、Claude 等 AI，它们就会进来一起讨论。你可以随时插话，最后写下结论。AI 之间的消息不代表你的授权。", 13f, MUTED).below(10))
        page.addView(primary("＋ 发起讨论") { startTopicDialog() }.below(14))
        poolError = text("", 13f, ORANGE).apply { visibility = View.GONE }.below(10)
        page.addView(poolError)
        poolBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        page.addView(poolBox)
        poolShown = null
        refreshPool()
    }

    private fun refreshPool() {
        val current = client ?: return
        val box = poolBox ?: return
        val token = screenToken
        // One request at a time, so a slow answer can never overwrite a newer one.
        if (poolLoadingToken == token) return
        poolLoadingToken = token
        work({ current.poolFeed() }, { error ->
            if (poolLoadingToken == token) poolLoadingToken = -1
            if (token != screenToken || poolBox !== box) return@work
            // Keep the last content on screen; a brief network drop should not wipe it.
            poolError?.apply {
                text = "读取聊天池失败：" + (error.message ?: "未知错误") + (if (box.childCount > 0) "（下面是上次读取的内容）" else "")
                visibility = View.VISIBLE
            }
        }) { feed ->
            if (poolLoadingToken == token) poolLoadingToken = -1
            if (token != screenToken || poolBox !== box) return@work
            poolError?.visibility = View.GONE
            val signature = feed.toString()
            if (signature == poolShown) return@work
            poolShown = signature
            renderPool(box, feed)
        }
    }

    private fun renderPool(box: LinearLayout, feed: JSONObject) {
        box.removeAllViews()
        val summary = card().below(14)
        summary.addView(text("活跃会话：" + feed.optInt("active_sessions") +
            "     待回应点名：" + feed.optInt("pending_ack_count"), 15f, INK, bold = true))
        val stale = feed.optInt("stale_pending_count")
        if (stale > 0) summary.addView(text("另有 $stale 条点名的对象已离线超过一天，不计入待回应", 12f, MUTED).below(4))
        val mine = feed.optInt("owner_pending")
        if (mine > 0) summary.addView(text("有 $mine 个问题在等你回复（带橙色标记的消息）", 14f, ORANGE, bold = true).below(6))
        val sessions = feed.optJSONArray("sessions")
        if (sessions != null && sessions.length() > 0) {
            val names = mutableListOf<String>()
            for (index in 0 until minOf(sessions.length(), 8)) {
                val s = sessions.getJSONObject(index)
                names.add(s.optString("agent") + " [" + s.optString("session_id").takeLast(6) + "]")
            }
            summary.addView(text("最近的 AI：" + names.joinToString(" · "), 12f, MUTED).below(5))
        }
        summary.addView(text("每 5 秒自动更新", 12f, MUTED).below(5))
        box.addView(summary)

        box.addView(text("讨论", 17f, INK, bold = true).below(22))
        val topics = feed.optJSONArray("topics")
        if (topics == null || topics.length() == 0) {
            box.addView(text("还没有讨论。点上面的「发起讨论」开始。", 14f, MUTED).below(8))
        } else {
            for (index in 0 until topics.length()) box.addView(topicCard(topics.getJSONObject(index)))
        }

        box.addView(text("全部消息（最新在上）", 17f, INK, bold = true).below(24))
        val messages = feed.optJSONArray("messages")
        if (messages == null || messages.length() == 0) {
            box.addView(text("还没有消息。", 14f, MUTED).below(8))
            return
        }
        for (index in messages.length() - 1 downTo 0) box.addView(messageCard(messages.getJSONObject(index), inPool = true))
    }

    private fun topicCard(topic: JSONObject): View {
        val id = topic.optInt("topic_id")
        val open = topic.optString("status") == "open"
        val card = card().below(10)
        card.addView(text("#$id  " + topic.optString("title"), 16f, INK, bold = true))
        val people = topic.optJSONArray("participants")
        val names = mutableListOf<String>()
        if (people != null) for (i in 0 until people.length()) {
            val p = people.getJSONObject(i)
            names.add(if (p.optBoolean("owner")) "主人" else p.optString("agent") + stateMark(p.optString("state")))
        }
        val who = if (names.isEmpty()) "还没有人发言" else names.distinct().joinToString("、")
        card.addView(text((if (open) "进行中" else "已结束") + " · " + topic.optInt("message_count") + " 条 · " + who +
            " · " + shortTime(topic.optString("last_at")), 12f, if (open) GREEN else MUTED).below(4))
        card.isClickable = true
        card.setOnClickListener { showTopic(id) }
        return card
    }

    private fun messageCard(msg: JSONObject, inPool: Boolean): View {
        val sender = msg.optJSONObject("sender") ?: JSONObject()
        val owner = sender.optBoolean("owner")
        val card = card().below(10)
        if (owner) (card.background as GradientDrawable).setColor(0xFFEFF6FF.toInt())
        val name = if (owner) "主人（你）" else sender.optString("agent", "AI")
        card.addView(text(name + " · #" + msg.optInt("seq"), 15f, if (owner) BLUE else INK, bold = true))
        val origin = if (owner) "手机" else "会话 " + sender.optString("session_id").takeLast(6) + " · " + sender.optString("computer").ifEmpty { "未声明电脑" }
        card.addView(text(origin + " · " + shortTime(msg.optString("created_at")), 12f, MUTED).below(3))
        // Selectable text in the discussion only; in the overview a tap opens the discussion.
        card.addView(text(msg.optString("content"), 15f, INK).apply { if (!inPool) setTextIsSelectable(true) }.below(8))
        val meta = mutableListOf<String>()
        val topicId = if (msg.isNull("topic_id")) 0 else msg.optInt("topic_id")
        if (inPool && topicId > 0) meta.add("讨论 #$topicId")
        when (msg.optString("type")) {
            "join" -> meta.add("加入聊天池")
            "topic" -> meta.add("发起讨论")
            "proposal" -> meta.add("方案")
            "help_request" -> meta.add("请求协助")
            "result" -> meta.add("结论")
        }
        // Only the server's own record marks an answer; a message's type alone could be claimed by anyone.
        val answered = msg.optJSONArray("acknowledges")
        if (answered != null && answered.length() > 0) {
            meta.add("回应了 " + (0 until answered.length()).joinToString("、") { "#" + answered.optInt(it) })
        } else if (!msg.isNull("reply_to")) meta.add("回复 #" + msg.optInt("reply_to"))
        val status = msg.optJSONArray("mention_status")
        var askedOwner: Boolean? = null
        if (status != null && status.length() > 0) {
            var acknowledged = 0
            for (i in 0 until status.length()) {
                val s = status.getJSONObject(i)
                if (s.optBoolean("acknowledged")) acknowledged += 1
                if (s.optString("session_id") == "owner") askedOwner = !s.optBoolean("acknowledged")
            }
            meta.add("点名 " + status.length() + " 个，已回应 " + acknowledged)
        }
        val decision = if (msg.isNull("decision")) "" else msg.optString("decision")
        if (decision.isNotEmpty()) meta.add("决定：" + decisionName(decision))
        if (meta.isNotEmpty()) card.addView(text(meta.joinToString(" · "), 12f, BLUE).below(6))
        if (askedOwner == true) {
            card.addView(text(if (topicId > 0) "在问你，在讨论里回复即可" else "在问你，等你回复", 13f, ORANGE, bold = true).below(6))
            if (topicId == 0) card.addView(primary("回复") { replyDialog(msg.optInt("seq")) }.below(8))
        } else if (askedOwner == false) {
            card.addView(text("你已回复", 12f, GREEN).below(4))
        }
        if (inPool && topicId > 0) {
            card.isClickable = true
            card.setOnClickListener { showTopic(topicId) }
        }
        return card
    }

    private fun stateMark(state: String) = when (state) {
        "waiting" -> "（等待中）"
        "active" -> "（在线）"
        "away" -> "（已离开）"
        else -> ""
    }

    // Answer a question an AI asked the owner outside a discussion.
    private fun replyDialog(messageId: Int) {
        val current = client ?: return
        val field = EditText(this).apply {
            hint = "你的回复"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 3
        }
        AlertDialog.Builder(this)
            .setTitle("回复 #$messageId")
            .setView(padded(field))
            .setPositiveButton("发送") { _, _ ->
                val content = field.text.toString().trim()
                if (content.isNotEmpty()) work({ current.postToPool(content, null, messageId) }, { error -> toast(error.message ?: "发送失败") }) {
                    toast("已回复")
                    poolShown = null
                    refreshPool()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun decisionName(value: String) = when (value) {
        "accept" -> "接受"
        "decline" -> "拒绝"
        "defer" -> "稍后"
        "clarify" -> "需要澄清"
        else -> value
    }

    private fun startTopicDialog() {
        val current = client ?: return
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val title = EditText(this).apply {
            hint = "议题，比如：Computer MCP 下一步做什么"
            inputType = InputType.TYPE_CLASS_TEXT
        }
        val goal = EditText(this).apply {
            hint = "想要的结果、背景、限制（可不填）"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 3
        }
        form.addView(title)
        form.addView(goal)
        val dialog = AlertDialog.Builder(this)
            .setTitle("发起讨论")
            .setView(padded(form))
            .setPositiveButton("发起", null)
            .setNegativeButton("取消", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val name = title.text.toString().trim()
                if (name.isEmpty()) {
                    title.error = "请写一个议题"
                    return@setOnClickListener
                }
                dialog.dismiss()
                work({ current.startTopic(name, goal.text.toString().trim()) }, { error -> toast(error.message ?: "发起失败") }) { topic ->
                    showTopic(topic.optInt("topic_id"))
                    showInviteText(topic.optString("invite"))
                }
            }
        }
        dialog.show()
    }

    private fun showInviteText(invite: String) {
        AlertDialog.Builder(this)
            .setTitle("把邀请语发给每个 AI")
            .setMessage("复制下面这段话，分别粘贴给要参加讨论的 AI（ChatGPT、Claude 等，需要已连接 Computer MCP）。\n\n$invite")
            .setPositiveButton("复制邀请语") { _, _ -> copy("邀请语", invite) }
            .setNegativeButton("关闭", null)
            .show()
    }

    // ---- One discussion: a scrolling conversation with a fixed input row ----
    private fun showTopic(topicId: Int) {
        resetScreen()
        backTo = { showPool() }
        currentTopic = topicId
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(PAGE)
            // Android 15 draws under the system bars unless the content asks for room.
            fitsSystemWindows = true
        }
        outer.addView(LinearLayout(this).apply {
            setPadding(dp(20), dp(24), dp(20), dp(8))
            addView(header("讨论 #$topicId") { showPool() }, MATCH_PARENT, WRAP_CONTENT)
        }, MATCH_PARENT, WRAP_CONTENT)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), 0, dp(20), dp(16))
        }
        val scroll = ScrollView(this).apply { addView(column, MATCH_PARENT, WRAP_CONTENT) }
        outer.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        val input = EditText(this).apply {
            hint = "以主人身份发言…"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            maxLines = 5
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(10).toFloat()
            }
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        val send = primary("发送") { sendOwnerMessage(input) }
        outer.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(8), dp(16), dp(12))
            setBackgroundColor(0xFFE5E7EB.toInt())
            addView(input, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(send, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = dp(10) })
        }, MATCH_PARENT, WRAP_CONTENT)
        // Keep the input row above the keyboard.
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        setContentView(outer)
        topicScroll = scroll
        topicBox = column
        topicInput = input
        topicSend = send
        topicShown = null
        refreshTopic(scrollToEnd = true)
    }

    private fun refreshTopic(scrollToEnd: Boolean = false) {
        val current = client ?: return
        val box = topicBox ?: return
        val topicId = currentTopic
        val token = screenToken
        if (poolLoadingToken == token) return
        poolLoadingToken = token
        work({ current.poolTopic(topicId) }, { error ->
            if (poolLoadingToken == token) poolLoadingToken = -1
            if (token != screenToken || topicBox !== box) return@work
            if (box.childCount == 0) box.addView(text("读取讨论失败：" + (error.message ?: "未知错误"), 14f, ORANGE).below(10))
        }) { feed ->
            if (poolLoadingToken == token) poolLoadingToken = -1
            if (token != screenToken || topicBox !== box) return@work
            val signature = feed.toString()
            if (signature == topicShown) return@work
            val scroll = topicScroll
            // Follow new messages only when the person is already reading the end.
            val atEnd = scrollToEnd || topicShown == null || scroll == null ||
                scroll.scrollY + scroll.height >= box.height - dp(120)
            topicShown = signature
            renderTopic(box, feed)
            if (atEnd && scroll != null) scroll.post { scroll.scrollTo(0, box.height) }
        }
    }

    private fun renderTopic(box: LinearLayout, feed: JSONObject) {
        val topic = feed.optJSONObject("topic") ?: return
        val open = topic.optString("status") == "open"
        box.removeAllViews()
        val head = card().below(8)
        head.addView(text(topic.optString("title"), 18f, INK, bold = true))
        head.addView(text(if (open) "进行中" else "已结束", 13f, if (open) GREEN else MUTED, bold = true).below(4))
        val goal = topic.optString("goal")
        if (goal.isNotEmpty()) head.addView(text("目标：$goal", 14f, INK).below(8))
        val people = topic.optJSONArray("participants")
        val names = mutableListOf<String>()
        if (people != null) for (i in 0 until people.length()) {
            val p = people.getJSONObject(i)
            names.add(if (p.optBoolean("owner")) "主人" else p.optString("agent") + " [" + p.optString("session_id").takeLast(6) + "]" + stateMark(p.optString("state")))
        }
        head.addView(text("参与：" + (if (names.isEmpty()) "还没有人" else names.joinToString(" · ")), 12f, MUTED).below(6))
        val actions = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        val invite = topic.optString("invite")
        actions.addView(secondary("复制邀请语") { copy("邀请语", invite) }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        val change = if (open) secondary("写结论并结束") { concludeDialog(topic.optInt("topic_id")) } else secondary("重新打开") { reopenTopic(topic.optInt("topic_id")) }
        actions.addView(change, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { leftMargin = dp(10) })
        head.addView(actions, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(12) })
        box.addView(head)
        if (!open) {
            val result = card().below(10)
            (result.background as GradientDrawable).setColor(0xFFECFDF5.toInt())
            val by = topic.optJSONObject("concluded_by")
            val who = if (by == null) "" else if (by.optBoolean("owner")) "主人" else by.optString("agent")
            result.addView(text("结论" + (if (who.isEmpty()) "" else "（$who 写的）"), 15f, GREEN, bold = true))
            result.addView(text(topic.optString("conclusion"), 15f, INK).apply { setTextIsSelectable(true) }.below(6))
            box.addView(result)
        }
        val messages = feed.optJSONArray("messages")
        if (messages == null || messages.length() == 0) {
            box.addView(text("还没有发言。把邀请语发给 AI 后，它们的发言会出现在这里。", 14f, MUTED).below(14))
        } else {
            val conclusion = "讨论结论：\n" + topic.optString("conclusion")
            for (index in 0 until messages.length()) {
                val msg = messages.getJSONObject(index)
                // The current conclusion is already shown in full above.
                if (!open && msg.optString("type") == "result" && msg.optString("content") == conclusion) {
                    val sender = msg.optJSONObject("sender") ?: JSONObject()
                    val who = if (sender.optBoolean("owner")) "主人" else sender.optString("agent")
                    box.addView(text("#" + msg.optInt("seq") + " " + who + " 写下了结论（见上方）· " + shortTime(msg.optString("created_at")), 13f, GREEN).below(12))
                } else box.addView(messageCard(msg, inPool = false))
            }
        }
        topicInput?.apply {
            isEnabled = open
            hint = if (open) "以主人身份发言…" else "讨论已结束，重新打开后才能发言"
        }
        topicSend?.apply {
            isEnabled = open
            alpha = if (open) 1f else 0.35f
        }
    }

    private fun sendOwnerMessage(input: EditText) {
        val current = client ?: return
        val content = input.text.toString().trim()
        if (content.isEmpty()) return
        val topicId = currentTopic
        val send = topicSend
        send?.isEnabled = false
        work({ current.postToPool(content, topicId) }, { error ->
            send?.isEnabled = true
            toast(error.message ?: "发送失败")
        }) {
            send?.isEnabled = true
            // Cleared only after the hub stored it, so a failed send keeps the text.
            if (input.text.toString().trim() == content) input.setText("")
            refreshTopic(scrollToEnd = true)
        }
    }

    private fun concludeDialog(topicId: Int) {
        val current = client ?: return
        val field = EditText(this).apply {
            hint = "定下的方案、分工、还没解决的问题"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 4
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle("写结论并结束讨论")
            .setView(padded(field))
            .setPositiveButton("结束讨论", null)
            .setNegativeButton("取消", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val conclusion = field.text.toString().trim()
                if (conclusion.isEmpty()) {
                    field.error = "请写下结论"
                    return@setOnClickListener
                }
                dialog.dismiss()
                work({ current.concludeTopic(topicId, conclusion) }, { error -> toast(error.message ?: "结束失败") }) {
                    toast("讨论已结束")
                    refreshTopic(scrollToEnd = true)
                }
            }
        }
        dialog.show()
    }

    private fun reopenTopic(topicId: Int) {
        val current = client ?: return
        work({ current.reopenTopic(topicId) }, { error -> toast(error.message ?: "重新打开失败") }) {
            toast("讨论已重新打开")
            refreshTopic(scrollToEnd = true)
        }
    }

    private fun header(title: String, onBack: () -> Unit) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        addView(text("‹", 30f, INK).apply {
            setPadding(0, 0, dp(14), dp(4))
            setOnClickListener { onBack() }
        })
        addView(text(title, 24f, INK, bold = true))
    }

    // The hub stores UTC times; show them in the phone's own time zone.
    private fun shortTime(iso: String): String {
        if (iso.isEmpty()) return ""
        return try {
            val parse = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            val time = parse.parse(iso) ?: return iso
            val day = SimpleDateFormat("yyyy-MM-dd", Locale.US)
            SimpleDateFormat(if (day.format(time) == day.format(Date())) "HH:mm" else "MM-dd HH:mm", Locale.US).format(time)
        } catch (_: Exception) {
            iso
        }
    }

    private fun refresh() {
        val current = client ?: return
        work({ current.status() }, { error ->
            errorLine?.apply {
                text = error.message
                visibility = View.VISIBLE
            }
            if ((error as? HubException)?.unauthorized == true) forget()
        }) { fresh ->
            errorLine?.visibility = View.GONE
            status = fresh
            announceNew(fresh)
            announceTakeovers(fresh)
            render(fresh)
        }
    }

    private fun announceNew(fresh: HubStatus) {
        val known = knownIds
        val added = if (known == null) emptyList() else fresh.computers.filter { it.id !in known }
        knownIds = fresh.computers.map { it.id }.toSet()
        if (added.isNotEmpty()) {
            pairDialog?.dismiss()
            toast("${added.joinToString("、") { it.name }} 已加入")
        }
    }

    private fun announceTakeovers(fresh: HubStatus) {
        for (computer in fresh.computers) {
            if (computer.takeover == null) {
                announcedTakeovers.remove(computer.id)
            } else if (announcedTakeovers.add(computer.id)) {
                toast("AI 请你接管 ${computer.name} 的浏览器")
            }
        }
    }

    private fun render(fresh: HubStatus) {
        poolButton?.text = if (fresh.poolAlerts.isEmpty()) "💬 AI 公共聊天池" else "💬 AI 公共聊天池 · " + fresh.poolAlerts.size + " 条提醒"

        val box = computersBox ?: return
        val shown = fresh.computers to fresh.secretRequests
        if (shown == shownComputers) return
        shownComputers = shown
        box.removeAllViews()
        for (request in fresh.secretRequests) box.addView(secretBanner(request).below(10))
        for (computer in fresh.computers.filter { it.takeover != null }) box.addView(takeoverBanner(computer).below(10))
        if (fresh.computers.isEmpty()) {
            box.addView(text("还没有电脑。点下面的“添加电脑”，在电脑上输入配对码就行。", 14f, MUTED).below(10))
        }
        for (computer in fresh.computers) box.addView(computerRow(computer).below(10))
    }

    private fun computerRow(computer: Computer): View {
        val row = card()
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.addView(View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(if (computer.online) GREEN else GRAY)
            }
        }, LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginEnd = dp(14) })

        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        body.addView(text(computer.name + if (computer.main) "（主电脑）" else "", 16f, INK, bold = true))
        val detail = listOf(if (computer.online) "在线" + viaLabel(computer) else "离线", computer.note.ifEmpty { computer.os })
            .filter { it.isNotEmpty() }.joinToString(" · ")
        body.addView(text(detail, 13f, MUTED).below(3))
        row.addView(body, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        row.addView(text("›", 22f, GRAY))
        row.setOnClickListener { showComputer(computer) }
        return row
    }

    private fun takeoverBanner(computer: Computer) = card().apply {
        background = GradientDrawable().apply {
            setColor(0xFFFFF7ED.toInt())
            setStroke(dp(1), ORANGE)
            cornerRadius = dp(14).toFloat()
        }
        addView(text("AI 请你接管 ${computer.name} 的浏览器", 16f, ORANGE, bold = true))
        addView(text("可能需要过人机验证或扫码登录：${computer.takeover.orEmpty()}", 13f, INK).below(4))
        addView(primary("去处理") { showTakeover(computer) }.below(10))
    }

    // ---- Saved accounts ----

    private fun secretBanner(request: SecretRequest) = card().apply {
        background = GradientDrawable().apply {
            setColor(0xFFEFF6FF.toInt())
            setStroke(dp(1), BLUE)
            cornerRadius = dp(14).toFloat()
        }
        val part = if (request.part == "username") "账号" else "密码"
        addView(text("AI 想在 ${request.computer} 上填写「${request.hint}」的$part", 16f, BLUE, bold = true))
        if (request.reason.isNotEmpty()) addView(text(request.reason, 13f, INK).below(4))
        addView(primary("选择账号") { approveSecret(request) }.below(10))
    }

    private fun approveSecret(request: SecretRequest) {
        val current = client ?: return
        val entries = vault.load()
        if (entries.isEmpty()) {
            AlertDialog.Builder(this)
                .setTitle("密码库里还没有账号")
                .setMessage("先把「${request.hint}」的账号密码存进来，再允许 AI 使用。")
                .setPositiveButton("添加账号") { _, _ -> editEntry(VaultEntry(label = request.hint, username = "", password = "")) { approveSecret(request) } }
                .setNegativeButton("拒绝") { _, _ -> answer(current, request, null) }
                .show()
            return
        }
        val match = vault.bestMatch(request.hint)
        var chosen = entries.indexOf(match).coerceAtLeast(0)
        val where = listOfNotNull(
            request.computer.let { "电脑：$it" },
            request.where.takeIf { it.isNotEmpty() }?.let { "位置：$it" },
            request.reason.takeIf { it.isNotEmpty() }?.let { "原因：$it" },
        ).joinToString("\n")
        AlertDialog.Builder(this)
            .setTitle("允许 AI 填写「${request.hint}」？")
            .setSingleChoiceItems(entries.map { "${it.label}  ·  ${it.username}" }.toTypedArray(), chosen) { _, which -> chosen = which }
            .setPositiveButton("允许填写") { _, _ ->
                AlertDialog.Builder(this)
                    .setTitle("确认")
                    .setMessage("$where\n\n将使用「${entries[chosen].label}」。只在你认得的登录页面上允许；密码会被直接输入电脑，AI 看不到。10 分钟内同一账号不再询问。")
                    .setPositiveButton("确认允许") { _, _ -> answer(current, request, entries[chosen]) }
                    .setNegativeButton("取消", null)
                    .show()
            }
            .setNegativeButton("拒绝") { _, _ -> answer(current, request, null) }
            .setNeutralButton("新建账号") { _, _ -> editEntry(VaultEntry(label = request.hint, username = "", password = "")) { approveSecret(request) } }
            .show()
    }

    private fun answer(current: HubClient, request: SecretRequest, entry: VaultEntry?) {
        work({ current.answerSecret(request.id, entry) }, { error -> toast(error.message ?: "失败") }) {
            toast(if (entry == null) "已拒绝" else "已允许，电脑上正在填写")
            refresh()
        }
    }

    private fun showVault() {
        val page = page()
        backTo = { showHome() }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(text("‹", 30f, INK).apply {
            setPadding(0, 0, dp(14), dp(4))
            setOnClickListener { showHome() }
        })
        header.addView(text("密码库", 24f, INK, bold = true))
        page.addView(header)
        page.addView(text("只加密保存在这部手机上，不会上传。AI 每次要用都会先问你，它只能让电脑把密码填进去，自己看不到。", 13f, MUTED).below(8))
        val entries = vault.load()
        if (entries.isEmpty()) page.addView(text("还没有保存的账号。", 14f, MUTED).below(16))
        for (entry in entries) {
            val row = card().below(10)
            row.addView(text(entry.label, 16f, INK, bold = true))
            row.addView(text(entry.username.ifEmpty { "（没有账号名）" } + "  ·  ••••••", 13f, MUTED).below(3))
            row.setOnClickListener { editEntry(entry) { showVault() } }
            page.addView(row)
        }
        page.addView(primary("＋ 添加账号") { editEntry(VaultEntry(label = "", username = "", password = "")) { showVault() } }.below(16))
    }

    private fun editEntry(entry: VaultEntry, after: () -> Unit) {
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val label = EditText(this).apply { setText(entry.label); hint = "名称，比如 GitHub、公司邮箱" }
        val username = EditText(this).apply { setText(entry.username); hint = "账号"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS }
        val password = EditText(this).apply { setText(entry.password); hint = "密码"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        form.addView(label)
        form.addView(username)
        form.addView(password)
        val known = vault.load().any { it.id == entry.id }
        val dialog = AlertDialog.Builder(this)
            .setTitle(if (known) "编辑账号" else "添加账号")
            .setView(padded(form))
            .setPositiveButton("保存") { _, _ ->
                val name = label.text.toString().trim()
                if (name.isEmpty()) {
                    toast("请填写名称")
                    return@setPositiveButton
                }
                vault.put(entry.copy(label = name, username = username.text.toString(), password = password.text.toString()))
                toast("已保存")
                after()
            }
            .setNegativeButton("取消", null)
        if (known) dialog.setNeutralButton("删除") { _, _ ->
            vault.remove(entry.id)
            toast("已删除")
            after()
        }
        dialog.show()
    }

    // ---- Background alerts ----

    private fun ensurePush() {
        if (!PushService.enabled(this)) return
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 7)
        }
        PushService.start(this)
    }

    // ---- One computer ----

    private fun currentComputer(id: String) = status?.computers?.find { it.id == id }

    private fun showComputer(computer: Computer) {
        val page = page()
        backTo = { showHome() }
        val token = screenToken
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(text("‹", 30f, INK).apply {
            setPadding(0, 0, dp(14), dp(4))
            setOnClickListener { showHome() }
        })
        header.addView(text(computer.name, 24f, INK, bold = true), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        page.addView(header)
        page.addView(text((if (computer.online) "● 在线" + viaLabel(computer) else "● 离线") + "  ·  " + computer.os, 14f, if (computer.online) GREEN else GRAY).below(4))
        if (!computer.main && computer.route != "public" && computer.lanProblem != null && (computer.route == "lan" || !computer.online || computer.via != "lan")) {
            page.addView(text("局域网：" + computer.lanProblem, 13f, MUTED).below(4))
        }
        if (computer.takeover != null) page.addView(takeoverBanner(computer).below(14))

        val browser = card().below(16)
        browser.addView(text("浏览器", 17f, INK, bold = true))
        if (!computer.desktop) {
            browser.addView(text("这台电脑没有安装桌面控制，看不到浏览器。在电脑的 Computer MCP 里点“安装桌面控制”。", 14f, MUTED).below(8))
        } else {
            val preview = ImageView(this).apply {
                scaleType = ImageView.ScaleType.FIT_CENTER
                setBackgroundColor(NIGHT)
                setOnClickListener { showTakeover(computer) }
            }
            browser.addView(preview, LinearLayout.LayoutParams(MATCH_PARENT, dp(210)).apply { topMargin = dp(10) })
            val line = text("正在读取浏览器画面…", 13f, MUTED).below(8)
            browser.addView(line)
            line.maxLines = 1
            line.ellipsize = TextUtils.TruncateAt.END
            browser.addView(primary("打开浏览器 ↗") { showTakeover(computer) }.below(10))
            browser.addView(secondary("选择浏览器窗口") { pickWindow(computer) { line.text = "已选择：$it" } }.below(8))
            fun load() {
                val current = client ?: return
                if (token != screenToken) return
                work({ current.browserFrame(computer.id) }, { error ->
                    if (token == screenToken) {
                        line.text = if ((error as? HubException)?.needsPick == true) "还没选择窗口。点“选择浏览器窗口”" else error.message
                        main.postDelayed({ load() }, PREVIEW_MS)
                    }
                }) { frame ->
                    if (token != screenToken) return@work
                    BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size)?.let { preview.setImageBitmap(it) }
                    line.text = frame.title.ifEmpty { "浏览器" }
                    main.postDelayed({ load() }, PREVIEW_MS)
                }
            }
            if (computer.online) load() else line.text = "电脑离线，看不到画面"
        }
        page.addView(browser)

        val settings = card().below(16)
        settings.addView(text("设置", 17f, INK, bold = true))
        settings.addView(secondary("改名 · 写用途 · 移除") { editComputer(currentComputer(computer.id) ?: computer) }.below(10))
        if (!computer.main) {
            settings.addView(secondary("连接方式：" + routeLabel(computer.route)) { chooseRoute(currentComputer(computer.id) ?: computer) }.below(8))
        }
        page.addView(settings)
    }

    // ---- Full-screen browser takeover ----

    private var takeoverComputer: Computer? = null
    private var takeoverMode = "tap"
    // Unspecified follows the phone; the rotate button pins one way until the takeover ends.
    private var takeoverOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // The activity is not recreated on rotation, so the takeover lays itself out again.
        takeoverComputer?.let { showTakeover(it) }
    }

    private fun leaveTakeover() {
        takeoverComputer = null
        takeoverOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        immersive(false)
    }

    @Suppress("DEPRECATION")
    private fun immersive(on: Boolean) {
        window.decorView.systemUiVisibility = if (on) {
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        } else {
            0
        }
    }

    private fun showTakeover(computer: Computer) {
        val current = client ?: return
        screenToken += 1
        val token = screenToken
        computersBox = null
        takeoverComputer = computer
        backTo = {
            leaveTakeover()
            showComputer(currentComputer(computer.id) ?: computer)
        }
        if (requestedOrientation != takeoverOrientation) requestedOrientation = takeoverOrientation
        val landscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        immersive(landscape)

        val screen = BrowserView(this).apply { mode = takeoverMode }
        val state = text("正在连接…", 12f, 0xFF9CA3AF.toInt()).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        var refreshNow: () -> Unit = {}
        fun send(action: JSONObject) {
            work({ current.browserInput(computer.id, action) }, { error -> state.text = error.message }) { refreshNow() }
        }
        screen.onAction = { send(it) }

        fun control(label: String, fill: Int = 0xFF1F2937.toInt(), onClick: () -> Unit) = button(label, fill, Color.WHITE, onClick).apply {
            textSize = 14f
            minHeight = dp(42)
            minimumHeight = dp(42)
            setPadding(dp(4), 0, dp(4), 0)
        }
        val modeButtons = mutableMapOf<String, Button>()
        fun paintModes() = modeButtons.forEach { (key, b) -> (b.background as GradientDrawable).setColor(if (key == takeoverMode) BLUE else 0xFF1F2937.toInt()) }
        for ((key, label) in listOf("tap" to "点按", "drag" to "拖动", "scroll" to "滚动")) {
            modeButtons[key] = control(label) {
                takeoverMode = key
                screen.mode = key
                paintModes()
            }
        }
        paintModes()
        val keyButtons = listOf("键盘" to "", "回车" to "enter", "退格" to "backspace", "Tab" to "tab", "Esc" to "esc").map { (label, key) ->
            control(label) {
                if (key.isEmpty()) askToType { typed -> send(JSONObject().put("action", "type").put("text", typed)) }
                else send(JSONObject().put("action", "key").put("keys", key))
            }
        }
        val fitButton = control("复位") { screen.fit() }
        val rotateButton = control(if (landscape) "竖屏" else "横屏") {
            takeoverOrientation = if (landscape) ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            requestedOrientation = takeoverOrientation
        }
        val finishButton = control("完成 · 交还给 AI", GREEN) {
            work({ current.browserFinish(computer.id) }, { error -> toast(error.message ?: "失败") }) {
                // Clear the request here too, so the page shown next has no stale banner.
                status = status?.let { s -> s.copy(computers = s.computers.map { if (it.id == computer.id) it.copy(takeover = null) else it }) }
                toast("已交还给 AI")
                refresh()
                backTo?.invoke()
            }
        }
        val back = text("‹", 30f, Color.WHITE).apply {
            setPadding(dp(8), 0, dp(12), dp(4))
            setOnClickListener { backTo?.invoke() }
        }
        fun row(vararg views: View, gap: Int = 6) = LinearLayout(this).apply {
            for ((i, v) in views.withIndex()) addView(v, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { if (i < views.size - 1) marginEnd = dp(gap) })
        }

        if (landscape) {
            // Picture fills the screen; the controls sit in one narrow column on the right.
            val root = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setBackgroundColor(NIGHT)
            }
            root.addView(screen, LinearLayout.LayoutParams(0, MATCH_PARENT, 1f))
            val column = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(6), dp(6), dp(6), dp(6))
            }
            column.addView(back)
            column.addView(state.apply { maxLines = 3; textSize = 11f })
            val buttons = modeButtons.values + keyButtons + listOf(fitButton, rotateButton)
            for (b in buttons) column.addView(b, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(5) })
            column.addView(finishButton.apply { text = "交还 AI" }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(10) })
            root.addView(ScrollView(this).apply { addView(column) }, LinearLayout.LayoutParams(dp(104), MATCH_PARENT))
            setContentView(root)
        } else {
            val root = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(NIGHT)
                fitsSystemWindows = true
                setPadding(dp(8), dp(6), dp(8), dp(8))
            }
            val top = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
            top.addView(back)
            val heading = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            heading.addView(text("${computer.name} 的浏览器", 16f, Color.WHITE, bold = true).apply { maxLines = 1 })
            heading.addView(state)
            top.addView(heading, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            top.addView(rotateButton, LinearLayout.LayoutParams(dp(72), WRAP_CONTENT))
            root.addView(top)
            root.addView(screen, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f).apply { topMargin = dp(6) })
            root.addView(text("单指：点按 / 长按右键 / 滑动滚动　双指：缩放、移动画面", 12f, 0xFF9CA3AF.toInt()).apply {
                gravity = Gravity.CENTER
                setPadding(0, dp(6), 0, 0)
            })
            root.addView(row(*(modeButtons.values.toList() + fitButton).toTypedArray()).below(6))
            root.addView(row(*keyButtons.toTypedArray()).below(6))
            root.addView(finishButton, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) })
            setContentView(root)
        }

        var waiting = false
        fun load() {
            if (token != screenToken || waiting) return
            waiting = true
            work({ current.browserFrame(computer.id) }, { error ->
                waiting = false
                if (token != screenToken) return@work
                if ((error as? HubException)?.needsPick == true) {
                    state.text = "先选择要接管的浏览器窗口"
                    pickWindow(computer) { load() }
                } else {
                    state.text = error.message
                    main.postDelayed({ load() }, 1500)
                }
            }) { frame ->
                waiting = false
                if (token != screenToken) return@work
                BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size)?.let { screen.setFrame(it) }
                state.text = frame.title
                main.postDelayed({ load() }, 250)
            }
        }
        refreshNow = { load() }
        load()
    }

    /** Lists the computer's browser windows; choosing one brings it to the front there. */
    private fun pickWindow(computer: Computer, onPicked: (String) -> Unit) {
        val current = client ?: return
        work({ current.browserWindows(computer.id) }, { error -> toast(error.message ?: "读取窗口失败") }) { windows ->
            if (windows.isEmpty()) {
                toast("${computer.name} 上没有打开的浏览器。先打开 Chrome、Edge 或 Firefox")
                return@work
            }
            val labels = windows.map { w ->
                val title = if (w.title.length > 60) w.title.take(60) + "…" else w.title
                title + (if (w.automation) "\n（AI 自动化用的浏览器，最好别动）" else "") + (if (w.minimized) "（已最小化）" else "")
            }
            AlertDialog.Builder(this)
                .setTitle("选择 ${computer.name} 上的浏览器窗口")
                .setItems(labels.toTypedArray()) { _, which ->
                    val window = windows[which]
                    work({ current.browserSelect(computer.id, window.hwnd) }, { error -> toast(error.message ?: "选择失败") }) { onPicked(window.title) }
                }
                .setNegativeButton("取消", null)
                .show()
        }
    }

    private fun askToType(onText: (String) -> Unit) {
        val input = EditText(this).apply { hint = "要输入的文字" }
        AlertDialog.Builder(this)
            .setTitle("输入到电脑浏览器")
            .setView(padded(input))
            .setPositiveButton("发送") { _, _ -> input.text.toString().takeIf { it.isNotEmpty() }?.let(onText) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun copyPart(label: String, pick: (HubStatus) -> String) {
        val current = status
        if (current == null) {
            toast("正在连接主电脑，请稍等")
            return
        }
        copy(label, pick(current), sensitive = true)
    }

    private fun copy(label: String, value: String, sensitive: Boolean = false) {
        val clip = ClipData.newPlainText(label, value)
        if (sensitive) {
            // Keeps it out of the keyboard's clipboard preview on Android 13 and later.
            clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        }
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
        toast("已复制$label")
    }

    private fun addComputer() {
        val current = client ?: return
        work({ current.invite() }, { error -> toast(error.message ?: "生成失败") }) { invite -> showInvite(invite) }
    }

    private fun showInvite(invite: Invite) {
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        body.addView(text("1. 在新电脑上安装并打开 Computer MCP", 15f, INK))
        body.addView(text("2. 把下面的配对码发到新电脑，粘贴后点“加入主电脑”", 15f, INK).below(8))
        body.addView(text(invite.pair, 17f, BLUE, bold = true).apply {
            setTextIsSelectable(true)
            typeface = Typeface.MONOSPACE
            setPadding(0, dp(16), 0, dp(12))
        })
        body.addView(text("${invite.minutes} 分钟内有效，只能用一次。加入成功后这个窗口会自动关闭。", 13f, MUTED))
        pairDialog = AlertDialog.Builder(this)
            .setTitle("添加电脑")
            .setView(padded(body))
            .setPositiveButton("复制配对码") { _, _ -> copy("配对码", invite.pair) }
            .setNeutralButton("发送到…") { _, _ ->
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, invite.pair)
                }, "发送配对码"))
            }
            .setNegativeButton("关闭", null)
            .show()
    }

    private fun showClientHelp() {
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val guides = listOf(
            "豆包" to "打开“技能·连接器”，右上角“新建”→“新建自定义连接器”。名称随便写，传输类型选 HTTP，服务器 URL 粘贴“复制 MCP 地址”的内容，Headers 留空。",
            "ChatGPT" to "在设置的“应用/连接器”里打开开发者模式，新建连接器，URL 粘贴“复制 MCP 地址”的内容，认证选“无”。",
            "Claude" to "设置 →“连接器”→“添加自定义连接器”，URL 粘贴“复制 MCP 地址”的内容。",
            "其他软件" to "只能填一个网址的，用“复制 MCP 地址”；要分开填网址和 Bearer 令牌的，分别用“只复制网址”和“只复制密钥”。",
        )
        for ((name, steps) in guides) {
            body.addView(text(name, 16f, INK, bold = true).below(12))
            body.addView(text(steps, 14f, INK).below(4))
        }
        body.addView(text("加了新电脑后，如果 AI 说找不到 computer 参数，在 AI 软件里刷新一下这个连接器。", 13f, MUTED).below(14))
        AlertDialog.Builder(this)
            .setTitle("接入 AI 软件")
            .setView(ScrollView(this).apply { addView(padded(body)) })
            .setPositiveButton("复制 MCP 地址") { _, _ -> copyPart("MCP 地址") { it.full } }
            .setNegativeButton("关闭", null)
            .show()
    }

    private fun viaLabel(computer: Computer): String = when (computer.via) {
        "lan" -> "（局域网）"
        "public" -> "（公网）"
        else -> ""
    }

    private fun routeLabel(route: String): String = when (route) {
        "lan" -> "只用局域网"
        "public" -> "只用公网"
        else -> "自动"
    }

    /** auto prefers the LAN and falls back; the other two never switch, and say so when they cannot work. */
    private fun chooseRoute(computer: Computer) {
        val current = client ?: return
        val routes = arrayOf("auto", "lan", "public")
        val labels = arrayOf("自动（优先局域网，不通就走公网）", "只用局域网（连不上就报错）", "只用公网")
        AlertDialog.Builder(this)
            .setTitle("${computer.name} 的连接方式")
            .setSingleChoiceItems(labels, routes.indexOf(computer.route).coerceAtLeast(0)) { dialog, which ->
                dialog.dismiss()
                if (routes[which] == computer.route) return@setSingleChoiceItems
                work({ current.setRoute(computer.id, routes[which]) }, { error -> toast(error.message ?: "保存失败") }) {
                    toast("已改为" + routeLabel(routes[which]))
                    refresh()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun editComputer(computer: Computer) {
        val current = client ?: return
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val name = EditText(this).apply {
            setText(computer.name)
            hint = "名字"
            inputType = InputType.TYPE_CLASS_TEXT
            isEnabled = !computer.main
        }
        val note = EditText(this).apply {
            setText(computer.note)
            hint = "用途，比如：工作室，装了 Blender"
            inputType = InputType.TYPE_CLASS_TEXT
        }
        form.addView(text("名字", 13f, MUTED))
        form.addView(name)
        form.addView(text("用途（AI 靠它决定用哪台电脑）", 13f, MUTED).below(10))
        form.addView(note)
        val builder = AlertDialog.Builder(this)
            .setTitle(computer.name)
            .setView(padded(form))
            .setPositiveButton("保存") { _, _ ->
                val newName = if (computer.main) null else name.text.toString().trim()
                work({ current.update(computer.id, newName, note.text.toString().trim()) }, { error -> toast(error.message ?: "保存失败") }) {
                    toast("已保存")
                    refresh()
                }
            }
            .setNegativeButton("取消", null)
        if (!computer.main) builder.setNeutralButton("移除") { _, _ -> confirmRemove(computer) }
        builder.show()
    }

    private fun confirmRemove(computer: Computer) {
        val current = client ?: return
        AlertDialog.Builder(this)
            .setTitle("移除 ${computer.name}？")
            .setMessage("移除后 AI 不能再控制这台电脑。要再加回来，需要重新配对。")
            .setPositiveButton("移除") { _, _ ->
                work({ current.remove(computer.id) }, { error -> toast(error.message ?: "移除失败") }) {
                    toast("已移除")
                    refresh()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun confirmForget() {
        AlertDialog.Builder(this)
            .setTitle("断开这部手机？")
            .setMessage("只是这部手机不再管理电脑。AI 仍能通过 MCP 地址控制电脑。")
            .setPositiveButton("断开") { _, _ -> forget() }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun forget() {
        PushService.stop(this)
        store.clear()
        connection = null
        client = null
        status = null
        knownIds = null
        main.removeCallbacks(refresher)
        showWelcome()
    }

    // ---- Helpers ----

    private fun <T> work(job: () -> T, onError: (Exception) -> Unit, onDone: (T) -> Unit) {
        background.execute {
            try {
                val result = job()
                runOnUiThread { if (!isDestroyed) onDone(result) }
            } catch (error: Exception) {
                runOnUiThread { if (!isDestroyed) onError(error) }
            }
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun resetScreen() {
        // Only the browser takeover turns sideways; every other screen is laid out upright.
        if (requestedOrientation != ActivityInfo.SCREEN_ORIENTATION_PORTRAIT) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        screenToken += 1
        computersBox = null
        activityBox = null
        activityNotice = null
        poolBox = null
        poolError = null
        topicBox = null
        topicScroll = null
        topicInput = null
        topicSend = null
        poolButton = null
        backTo = null
    }

    private fun page(): LinearLayout {
        resetScreen()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(32))
        }
        setContentView(ScrollView(this).apply {
            setBackgroundColor(PAGE)
            // Android 15 draws under the system bars unless the content asks for room.
            fitsSystemWindows = true
            addView(column, MATCH_PARENT, WRAP_CONTENT)
        })
        return column
    }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(18), dp(16), dp(18), dp(16))
        background = GradientDrawable().apply {
            setColor(Color.WHITE)
            cornerRadius = dp(14).toFloat()
        }
    }

    private fun text(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun button(label: String, fill: Int, ink: Int, onClick: () -> Unit) = Button(this).apply {
        text = label
        textSize = 15f
        isAllCaps = false
        stateListAnimator = null
        setTextColor(ink)
        minHeight = dp(48)
        background = GradientDrawable().apply {
            setColor(fill)
            cornerRadius = dp(10).toFloat()
        }
        setOnClickListener { onClick() }
    }

    private fun primary(label: String, onClick: () -> Unit) = button(label, BLUE, Color.WHITE, onClick)

    private fun secondary(label: String, onClick: () -> Unit) = button(label, 0xFFE5E7EB.toInt(), INK, onClick)

    private fun padded(view: View) = LinearLayout(this).apply {
        setPadding(dp(22), dp(8), dp(22), 0)
        addView(view, MATCH_PARENT, WRAP_CONTENT)
    }

    private fun <V : View> V.below(margin: Int): V = apply {
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(margin) }
    }

    companion object {
        const val EXTRA_TOPIC = "topic"
    }
}
