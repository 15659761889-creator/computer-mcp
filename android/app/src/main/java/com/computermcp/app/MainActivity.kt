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
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.view.WindowManager
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.CheckBox
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
                else -> refresh()
            }
            main.postDelayed(this, if (activityBox != null) ACTIVITY_REFRESH_MS else REFRESH_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Lang.init(this)
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
        val text = intent?.dataString ?: return
        intent.data = null
        Connection.parseInvite(text)?.let { (host, code) ->
            AlertDialog.Builder(this)
                .setTitle(tr("使用这个中转服务？", "Use this relay server?"))
                .setMessage(tr("服务器：$host\n\nAI 的指令和电脑返回的结果会经过这台服务器。只接受你信任的人给的邀请。", "Server: $host\n\nThe AI's commands and your computers' results will pass through this server. Only accept invites from people you trust."))
                .setPositiveButton(tr("接受", "Accept")) { _, _ -> acceptInvite(host, code) }
                .setNegativeButton(tr("取消", "Cancel"), null)
                .show()
            return
        }
        val parsed = Connection.parse(text) ?: return
        AlertDialog.Builder(this)
            .setTitle(tr("连接这台服务器？", "Connect to this server?"))
            .setMessage(tr("地址：${parsed.host}\n\n只连接你自己的电脑或服务器。", "Address: ${parsed.host}\n\nOnly connect to your own computers or servers."))
            .setPositiveButton(tr("连接", "Connect")) { _, _ -> connect(parsed) }
            .setNegativeButton(tr("取消", "Cancel"), null)
            .show()
    }

    private fun acceptInvite(host: String, code: String) {
        if (connection != null) {
            toast(tr("请先点右上角“断开”，再接受新的邀请", "Tap “Disconnect” at the top right first, then accept the new invite"))
            return
        }
        toast(tr("正在加入…", "Joining…"))
        work({ Connection.signUp(host, code) }, { error -> toast(error.message ?: tr("加入失败", "Couldn’t join")) }) { connect(it) }
    }

    private fun accept(text: String) {
        val invite = Connection.parseInvite(text)
        val own = Connection.parse(text)
        when {
            invite != null -> acceptInvite(invite.first, invite.second)
            own != null -> connect(own)
            else -> toast(tr("这不是 Computer MCP 的二维码或邀请", "This isn’t a Computer MCP QR code or invite"))
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
        page.addView(text(tr("一个地址，让 AI 控制你所有的电脑", "One address that lets your AI control all your computers"), 15f, MUTED).below(6))

        val steps = card().below(28)
        steps.addView(text(tr("怎么开始", "How to start"), 17f, INK, bold = true))
        steps.addView(text(tr("1. 找到二维码：自己租的服务器装好后会显示一个；常开电脑在 Computer MCP 里点“连接手机 App”；用别人的服务，就用他给你的邀请", "1. Find the QR code: a server you rent shows one after setup; on an always-on computer, tap “Connect phone app” in Computer MCP; for someone else’s service, use the invite they gave you"), 15f, INK).below(12))
        steps.addView(text(tr("2. 用下面的按钮扫码", "2. Scan it with the button below"), 15f, INK).below(8))
        steps.addView(text(tr("3. 添加电脑，再把地址填进豆包、ChatGPT 等 AI 软件", "3. Add your computers, then paste the address into your AI app (ChatGPT, Claude, etc.)"), 15f, INK).below(8))
        page.addView(steps)

        page.addView(primary(tr("扫码连接", "Scan to connect")) { scan() }.below(24))
        page.addView(secondary(tr("扫不了？粘贴连接文本", "Can’t scan? Paste the connection text")) { askForText() }.below(10))
        page.addView(text("语言 / Language: " + languageName(), 14f, BLUE).apply {
            setPadding(0, dp(16), 0, dp(8))
            setOnClickListener { pickLanguage { showWelcome() } }
        })
    }

    private fun languageName() = when (Lang.setting) {
        Lang.ZH -> "中文"
        Lang.EN -> "English"
        else -> "自动 / Auto"
    }

    // The choices are always written in both languages, so a wrong choice can be undone.
    private fun pickLanguage(redraw: () -> Unit) {
        val values = arrayOf(Lang.AUTO, Lang.ZH, Lang.EN)
        AlertDialog.Builder(this)
            .setTitle("语言 / Language")
            .setSingleChoiceItems(arrayOf("自动（跟随手机）/ Auto (follow the phone)", "中文", "English"), values.indexOf(Lang.setting).coerceAtLeast(0)) { dialog, which ->
                Lang.set(this, values[which])
                dialog.dismiss()
                redraw()
            }
            .setNegativeButton(tr("取消", "Cancel"), null)
            .show()
    }

    private fun scan() {
        IntentIntegrator(this)
            .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
            .setPrompt(tr("对准电脑上的二维码", "Point at the QR code on your computer"))
            .setBeepEnabled(false)
            .setOrientationLocked(false)
            .initiateScan()
    }

    private fun askForText() {
        val input = EditText(this).apply { hint = "computermcp://…" }
        AlertDialog.Builder(this)
            .setTitle(tr("粘贴连接文本或邀请", "Paste the connection text or invite"))
            .setView(padded(input))
            .setPositiveButton(tr("连接", "Connect")) { _, _ -> accept(input.text.toString()) }
            .setNegativeButton(tr("取消", "Cancel"), null)
            .show()
    }

    private fun connect(next: Connection) {
        val candidate = HubClient(next)
        toast(tr("正在连接…", "Connecting…"))
        work({ candidate.status() }, { error -> toast(error.message ?: tr("连接失败", "Couldn’t connect")) }) { fresh ->
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
        header.addView(text(tr("我的电脑", "My computers"), 26f, INK, bold = true), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        header.addView(text(tr("断开", "Disconnect"), 14f, MUTED).apply {
            setPadding(dp(12), dp(8), 0, dp(8))
            setOnClickListener { confirmForget() }
        })
        page.addView(header)

        errorLine = text("", 14f, 0xFFB91C1C.toInt()).apply { visibility = View.GONE }.below(8)
        page.addView(errorLine)

        val mcp = card().below(16)
        mcp.addView(text(tr("统一 MCP 地址", "Unified MCP address"), 17f, INK, bold = true))
        mcp.addView(text(tr("粘贴到豆包、ChatGPT、Claude 等 AI 软件。所有电脑都用这一个地址。", "Paste it into your AI app (ChatGPT, Claude, etc.). All your computers use this one address."), 14f, MUTED).below(6))
        mcp.addView(primary(tr("复制 MCP 地址", "Copy MCP address")) { copyPart(tr("MCP 地址", "MCP address")) { it.full } }.below(14))
        val parts = LinearLayout(this)
        parts.addView(secondary(tr("只复制网址", "Copy URL only")) { copyPart(tr("网址", "URL")) { it.address } }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(8) })
        parts.addView(secondary(tr("只复制密钥", "Copy key only")) { copyPart(tr("密钥", "key")) { it.key } }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        mcp.addView(parts.below(8))
        mcp.addView(text(tr("如果 AI 软件要求分开填写网址和密钥，才用上面两个按钮。这个地址能控制你所有的电脑，不要发给别人。", "Use the two buttons above only if your AI app asks for the URL and key separately. This address can control all your computers; don’t share it."), 12f, MUTED).below(10))
        mcp.addView(text(tr("怎么填进豆包、ChatGPT？", "How do I add this to my AI app?"), 14f, BLUE).apply {
            setPadding(0, dp(10), 0, dp(4))
            setOnClickListener { showClientHelp() }
        })
        page.addView(mcp)

        page.addView(text(tr("电脑", "Computers"), 17f, INK, bold = true).below(24))
        computersBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        page.addView(computersBox)
        page.addView(primary(tr("＋ 添加电脑", "+ Add computer")) { addComputer() }.below(16))
        page.addView(secondary(tr("管理 AI 访问密钥", "Manage AI access keys")) { showClientTokens() }.below(10))
        page.addView(secondary(tr("AI 正在做什么", "What the AI is doing")) { showActivity() }.below(10))
        page.addView(secondary(tr("AI 的共享记忆", "AI shared memory")) { showMemory() }.below(10))

        val extras = card().below(24)
        extras.addView(text(tr("密码库", "Password vault"), 17f, INK, bold = true))
        extras.addView(text(tr("账号密码只加密保存在这部手机上。AI 要登录时先问你，你选好账号，电脑上直接填好，AI 看不到密码。", "Account passwords are stored encrypted on this phone only. When the AI needs to log in, it asks you first; you pick the account and the computer fills it in directly, so the AI never sees the password."), 13f, MUTED).below(6))
        extras.addView(secondary(tr("管理保存的账号（${vault.load().size}）", "Manage saved accounts (${vault.load().size})")) { showVault() }.below(10))
        extras.addView(text(tr("后台提醒", "Background alerts"), 17f, INK, bold = true).below(20))
        val pushLine = text("", 14f, INK).below(6)
        fun paintPush() {
            pushLine.text = if (PushService.enabled(this)) tr("已开启：AI 需要你时会弹通知（点这里关闭）", "On: you’ll get a notification when the AI needs you (tap to turn off)") else tr("已关闭：只有打开 App 才能看到 AI 的请求（点这里开启）", "Off: you only see the AI’s requests when the app is open (tap to turn on)")
        }
        paintPush()
        pushLine.setOnClickListener {
            PushService.setEnabled(this, !PushService.enabled(this))
            if (PushService.enabled(this)) ensurePush()
            paintPush()
        }
        extras.addView(pushLine)
        extras.addView(text(tr("收不到通知时，在手机设置里允许 Computer MCP 自启动和后台运行（vivo、小米、华为等都要设置）。", "If notifications don’t arrive, allow Computer MCP to auto-start and run in the background in your phone settings (needed on vivo, Xiaomi, Huawei, etc.)."), 12f, MUTED).below(6))
        page.addView(extras)

        val language = card().below(16)
        language.addView(text("语言 / Language", 17f, INK, bold = true))
        language.addView(secondary(languageName()) { pickLanguage { showHome() } }.below(10))
        page.addView(language)

        status?.let { render(it) }
    }

    private fun showActivity() {
        val page = page()
        backTo = { showHome() }
        page.addView(header(tr("AI 正在做什么", "What the AI is doing")) { showHome() })
        page.addView(text(tr("显示通过 Computer MCP 发出的工具调用，打开本页时自动更新。", "Shows tool calls made through Computer MCP; updates automatically while this page is open."), 13f, MUTED).below(10))
        activityNotice = text(tr("正在读取活动…", "Loading activity…"), 13f, MUTED).below(10).also { page.addView(it) }
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
                text = if (reason == "not found") tr("当前主机版本不支持活动列表，请升级 Computer MCP 主机。", "This host version doesn’t support the activity list. Please upgrade the Computer MCP host.")
                else tr("读取活动失败", "Couldn’t load activity") + (if (reason.isNullOrBlank()) tr("，正在重试。", ", retrying.") else "：$reason") +
                    (if (box.childCount > 0) tr("（下方为上次读取的记录）", " (showing the previous load below)") else "")
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
        box.addView(text(tr("进行中（${active.length()}）", "In progress (${active.length()})"), 17f, INK, bold = true))
        if (active.length() == 0) {
            box.addView(text(tr("当前没有进行中的工具调用。AI 可能在思考、等待回复或已经结束。", "No tool calls in progress. The AI may be thinking, waiting for a reply, or finished."), 14f, MUTED).below(8))
        }
        for (index in 0 until active.length()) {
            box.addView(activityCard(active.getJSONObject(index), clock))
        }
        box.addView(text(tr("最近完成的调用", "Recently completed calls"), 17f, INK, bold = true).below(22))
        if (recent.length() == 0) box.addView(text(tr("暂无记录", "Nothing yet"), 14f, MUTED).below(8))
        for (index in 0 until recent.length()) {
            box.addView(activityCard(recent.getJSONObject(index), clock))
        }
    }

    private fun activityCard(entry: JSONObject, clock: SimpleDateFormat): LinearLayout {
        val action = when (entry.getString("action")) {
            "list_computers" -> tr("查看电脑列表", "List computers")
            "search" -> tr("搜索文件或内容", "Search files or contents")
            "list_files" -> tr("查看文件列表", "List files")
            "bash" -> tr("运行命令", "Run a command")
            "job" -> tr("管理电脑任务", "Manage computer jobs")
            "read_file" -> tr("读取文件", "Read a file")
            "write_file" -> tr("写入文件", "Write a file")
            "edit_file" -> tr("编辑文件", "Edit a file")
            "ui_look" -> tr("查看电脑屏幕", "Look at the computer screen")
            "ui_act" -> tr("操作电脑界面", "Operate the computer UI")
            "type_secret" -> tr("请求使用已保存的账号", "Request a saved account")
            "request_human_takeover" -> tr("请求手机接管", "Request phone takeover")
            "check_human_takeover" -> tr("查看接管状态", "Check takeover status")
            "cancel_human_takeover" -> tr("结束接管", "End takeover")
            "memory_write" -> tr("写入共享记忆", "Write shared memory")
            "memory_forget" -> tr("删除共享记忆", "Delete shared memory")
            "transfer" -> tr("在电脑之间传文件", "Transfer files between computers")
            "browser" -> tr("使用 AI 浏览器", "Use the AI browser")
            else -> tr("调用工具", "Call a tool")
        }
        val (status, color) = when (entry.optString("status")) {
            "succeeded" -> tr("成功", "Succeeded") to GREEN
            "failed" -> tr("失败", "Failed") to ORANGE
            "background" -> tr("已交给后台任务，结果待确认", "Handed to a background job; result pending") to ORANGE
            "unknown" -> tr("结果未知", "Result unknown") to ORANGE
            else -> tr("调用进行中", "In progress") to BLUE
        }
        val computer = if (entry.isNull("computer")) "" else " · ${entry.getString("computer")}"
        val time = clock.format(Date(entry.getLong("startedAt")))
        val duration = entry.optLong("durationMs", -1)
        val elapsed = when {
            duration < 0 -> ""
            duration < 1000 -> tr(" · ${duration} 毫秒", " · ${duration} ms")
            else -> " · " + String.format(Locale.getDefault(), tr("%.1f 秒", "%.1f s"), duration / 1000.0)
        }
        return card().apply {
            addView(text(action + computer, 15f, INK, bold = true))
            addView(text(time + elapsed, 13f, MUTED).below(6))
            addView(text(status, 13f, color).below(4))
        }.below(10)
    }

    // ---- Shared memory ----

    private fun showMemory() {
        val current = client ?: return
        val page = page()
        backTo = { showHome() }
        val token = screenToken
        page.addView(header(tr("共享记忆", "Shared memory")) { showHome() })
        page.addView(text(tr("AI 之间互相留的笔记。你的笔记会交给每个连上来的 AI，锁定后 AI 改不了也删不掉；AI 写的笔记只有 AI 主动读取时才看得到。", "Notes the AIs leave for each other. Your notes go to every AI that connects; once locked, the AI can’t change or delete them. Notes written by an AI are only seen when an AI chooses to read them."), 13f, MUTED).below(10))
        val notice = text(tr("正在读取…", "Loading…"), 13f, MUTED).below(10)
        page.addView(notice)
        page.addView(primary(tr("＋ 添加我的笔记", "+ Add my note")) { addMemoryNote() }.below(14))
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        page.addView(box)
        work({ current.memory() }, { error ->
            if (token != screenToken) return@work
            notice.text = error.message ?: tr("读取失败", "Couldn’t load")
            notice.setTextColor(ORANGE)
        }) { view ->
            if (token != screenToken) return@work
            val mine = view.notes.filter { it.owner }
            val fromAi = view.notes.filter { !it.owner }
            notice.text = tr("共 ${view.notes.size} 条笔记，${view.chars} 字。", "${view.notes.size} notes, ${view.chars} characters.")
            box.addView(secondary(tr("撤销 AI 写入的内容…", "Undo what the AIs wrote…")) { chooseRevoke(view.authors) }.below(10))
            box.addView(text(tr("我的笔记（${mine.size}）", "My notes (${mine.size})"), 17f, INK, bold = true).below(22))
            if (mine.isEmpty()) box.addView(text(tr("还没有。可以写下你希望每个 AI 都知道的规则和情况。", "None yet. Write down the rules and context you want every AI to know."), 14f, MUTED).below(8))
            mine.forEach { box.addView(memoryCard(it)) }
            box.addView(text(tr("AI 写的笔记（${fromAi.size}）", "Notes written by AIs (${fromAi.size})"), 17f, INK, bold = true).below(22))
            if (fromAi.isEmpty()) box.addView(text(tr("还没有 AI 留下笔记。", "No AI has left a note yet."), 14f, MUTED).below(8))
            fromAi.forEach { box.addView(memoryCard(it)) }
        }
    }

    private fun memoryMeta(note: MemoryNote): String = listOfNotNull(
        if (note.locked) tr("已锁定", "Locked") else null,
        if (note.owner) tr("我写的", "Mine") else "AI：${note.author}",
        shortTime(note.updated),
        note.computer,
    ).joinToString(" · ")

    private fun memoryCard(note: MemoryNote) = card().apply {
        addView(text(note.key ?: tr("交接记录", "Handoff"), 15f, INK, bold = true))
        addView(text(memoryMeta(note), 12f, if (note.locked) GREEN else MUTED).below(4))
        addView(text(note.displayText, 14f, INK).apply {
            maxLines = 6
            ellipsize = TextUtils.TruncateAt.END
        }.below(8))
        setOnClickListener { openMemoryNote(note) }
    }.below(10)

    private fun openMemoryNote(note: MemoryNote) {
        val current = client ?: return
        val details = buildString {
            append(note.displayText)
            if (note.stateEvidence != null) append(tr("\n\n报告的证据（请核实）：\n", "\n\nReported evidence (verify before use):\n")).append(note.stateEvidence)
            append("\n\n").append(memoryMeta(note))
            if (!note.owner && note.via != null) append(tr("\n来自：", "\nFrom: ")).append(note.via)
        }
        AlertDialog.Builder(this)
            .setTitle(note.key ?: tr("交接记录", "Handoff"))
            .setMessage(details)
            .setPositiveButton(if (note.locked) tr("解锁", "Unlock") else tr("锁定", "Lock")) { _, _ ->
                work({ current.memoryLock(note.id, !note.locked) }, { error -> toast(error.message ?: tr("操作失败", "Action failed")) }) {
                    toast(if (note.locked) tr("已解锁，AI 可以修改它了", "Unlocked; AIs can edit it now") else tr("已锁定，这条笔记现在算你的", "Locked; this note now counts as yours"))
                    showMemory()
                }
            }
            .setNeutralButton(tr("删除", "Delete")) { _, _ ->
                AlertDialog.Builder(this)
                    .setTitle(tr("删除这条笔记？", "Delete this note?"))
                    .setMessage(tr("会从电脑上彻底抹掉，不能恢复。", "It will be erased from the computer for good and can’t be recovered."))
                    .setPositiveButton(tr("删除", "Delete")) { _, _ ->
                        work({ current.memoryForget(note.id) }, { error -> toast(error.message ?: tr("删除失败", "Couldn’t delete")) }) {
                            toast(tr("已删除", "Deleted"))
                            showMemory()
                        }
                    }
                    .setNegativeButton(tr("取消", "Cancel"), null)
                    .show()
            }
            .setNegativeButton(tr("关闭", "Close"), null)
            .show()
    }

    private fun addMemoryNote() {
        val current = client ?: return
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val key = EditText(this).apply { hint = tr("名称，比如 规则.重启、电脑2.用途", "Name, e.g. rules.restart, pc2.purpose") }
        val body = EditText(this).apply { hint = tr("内容，一句话说清楚", "Content, in one clear sentence"); minLines = 3 }
        val computer = EditText(this).apply { hint = tr("关于哪台电脑（可不填）", "Which computer it’s about (optional)") }
        val locked = CheckBox(this).apply { text = tr("锁定（AI 不能修改或删除）", "Locked (AIs can’t change or delete it)"); isChecked = true }
        listOf(key, body, computer, locked).forEach { form.addView(it) }
        AlertDialog.Builder(this)
            .setTitle(tr("添加我的笔记", "Add my note"))
            .setView(padded(form))
            .setPositiveButton(tr("保存", "Save")) { _, _ ->
                val name = key.text.toString().trim()
                val content = body.text.toString().trim()
                if (name.isEmpty() || content.isEmpty()) {
                    toast(tr("名称和内容都要填", "Both name and content are required"))
                    return@setPositiveButton
                }
                work({ current.memoryAdd(name, content, computer.text.toString().trim(), locked.isChecked) }, { error -> toast(error.message ?: tr("保存失败", "Couldn’t save")) }) {
                    toast(tr("已保存", "Saved"))
                    showMemory()
                }
            }
            .setNegativeButton(tr("取消", "Cancel"), null)
            .show()
    }

    // The name an AI gives is only what it says about itself, so undoing by time is the sure way.
    private fun chooseRevoke(authors: List<MemoryAuthor>) {
        val hour = 60 * 60 * 1000L
        val midnight = java.util.Calendar.getInstance().apply {
            set(java.util.Calendar.HOUR_OF_DAY, 0)
            set(java.util.Calendar.MINUTE, 0)
            set(java.util.Calendar.SECOND, 0)
            set(java.util.Calendar.MILLISECOND, 0)
        }.timeInMillis
        val choices = mutableListOf<Pair<String, () -> Pair<String?, Long?>>>(
            tr("所有 AI 最近 1 小时写的", "Everything all AIs wrote in the last hour") to { null to System.currentTimeMillis() - hour },
            tr("所有 AI 今天写的", "Everything all AIs wrote today") to { null to midnight },
            tr("所有 AI 写的全部内容", "Everything all AIs ever wrote") to { null to 0L },
        )
        authors.filter { !it.author.equals("owner", ignoreCase = true) }.forEach { a ->
            val from = if (a.via.isEmpty()) "" else tr("，来自 ${a.via.first()}", ", from ${a.via.first()}")
            choices += tr("只撤销「${a.author}」（${a.writes} 次${from}）", "Only undo “${a.author}” (${a.writes} writes${from})") to { a.author to null }
        }
        AlertDialog.Builder(this)
            .setTitle(tr("撤销哪些写入？", "Undo which writes?"))
            .setItems(choices.map { it.first }.toTypedArray()) { _, which ->
                val (label, pick) = choices[which]
                val (author, since) = pick()
                AlertDialog.Builder(this)
                    .setTitle(tr("确认撤销", "Confirm undo"))
                    .setMessage(tr("$label：它们新写的、改过的、删掉的都会恢复原样，写入的文字会从电脑上抹掉。你自己的笔记不受影响。", "$label: whatever they newly wrote, changed or deleted will be restored, and the text they wrote will be erased from the computer. Your own notes are not affected."))
                    .setPositiveButton(tr("撤销", "Undo")) { _, _ ->
                        val current = client ?: return@setPositiveButton
                        work({ current.memoryRevoke(author, since) }, { error -> toast(error.message ?: tr("撤销失败", "Undo failed")) }) { count ->
                            toast(if (count == 0) tr("没有需要撤销的写入", "No writes to undo") else tr("已撤销 $count 次写入", "Undid $count writes"))
                            showMemory()
                        }
                    }
                    .setNegativeButton(tr("取消", "Cancel"), null)
                    .show()
            }
            .setNegativeButton(tr("取消", "Cancel"), null)
            .show()
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
            toast(tr("${added.joinToString("、") { it.name }} 已加入", "${added.joinToString(", ") { it.name }} joined"))
        }
    }

    private fun announceTakeovers(fresh: HubStatus) {
        for (computer in fresh.computers) {
            if (computer.takeover == null) {
                announcedTakeovers.remove(computer.id)
            } else if (announcedTakeovers.add(computer.id)) {
                toast(tr("AI 请你接管 ${computer.name} 的浏览器", "The AI asks you to take over the browser on ${computer.name}"))
            }
        }
    }

    private fun render(fresh: HubStatus) {
        val box = computersBox ?: return
        val shown = fresh.computers to fresh.secretRequests
        if (shown == shownComputers) return
        shownComputers = shown
        box.removeAllViews()
        for (request in fresh.secretRequests) box.addView(secretBanner(request).below(10))
        for (computer in fresh.computers.filter { it.takeover != null }) box.addView(takeoverBanner(computer).below(10))
        if (fresh.computers.isEmpty()) {
            box.addView(text(tr("还没有电脑。点下面的“添加电脑”，在电脑上输入配对码就行。", "No computers yet. Tap “Add computer” below, then enter the pairing code on the computer."), 14f, MUTED).below(10))
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
        body.addView(text(computer.name + if (computer.main) tr("（主电脑）", " (main computer)") else "", 16f, INK, bold = true))
        val detail = listOf(if (computer.online) tr("在线", "Online") + viaLabel(computer) else tr("离线", "Offline"), computer.note.ifEmpty { computer.os })
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
        addView(text(tr("AI 请你接管 ${computer.name} 的浏览器", "The AI asks you to take over the browser on ${computer.name}"), 16f, ORANGE, bold = true))
        addView(text(tr("可能需要过人机验证或扫码登录：${computer.takeover.orEmpty()}", "May need a human check or QR login: ${computer.takeover.orEmpty()}"), 13f, INK).below(4))
        addView(primary(tr("去处理", "Handle it")) { showTakeover(computer) }.below(10))
    }

    // ---- Saved accounts ----

    private fun secretBanner(request: SecretRequest) = card().apply {
        background = GradientDrawable().apply {
            setColor(0xFFEFF6FF.toInt())
            setStroke(dp(1), BLUE)
            cornerRadius = dp(14).toFloat()
        }
        val part = if (request.part == "username") tr("账号", "username") else tr("密码", "password")
        addView(text(tr("AI 想在 ${request.computer} 上填写「${request.hint}」的$part", "The AI wants to fill in the $part for “${request.hint}” on ${request.computer}"), 16f, BLUE, bold = true))
        if (request.reason.isNotEmpty()) addView(text(request.reason, 13f, INK).below(4))
        addView(primary(tr("选择账号", "Choose an account")) { approveSecret(request) }.below(10))
    }

    private fun approveSecret(request: SecretRequest) {
        val current = client ?: return
        val entries = vault.load()
        if (entries.isEmpty()) {
            AlertDialog.Builder(this)
                .setTitle(tr("密码库里还没有账号", "No accounts in the vault yet"))
                .setMessage(tr("先把「${request.hint}」的账号密码存进来，再允许 AI 使用。", "Save the account for “${request.hint}” first, then allow the AI to use it."))
                .setPositiveButton(tr("添加账号", "Add account")) { _, _ -> editEntry(VaultEntry(label = request.hint, username = "", password = "")) { approveSecret(request) } }
                .setNegativeButton(tr("拒绝", "Deny")) { _, _ -> answer(current, request, null) }
                .show()
            return
        }
        val match = vault.bestMatch(request.hint)
        var chosen = entries.indexOf(match).coerceAtLeast(0)
        val where = listOfNotNull(
            request.computer.let { tr("电脑：$it", "Computer: $it") },
            request.where.takeIf { it.isNotEmpty() }?.let { tr("位置：$it", "Location: $it") },
            request.reason.takeIf { it.isNotEmpty() }?.let { tr("原因：$it", "Reason: $it") },
        ).joinToString("\n")
        AlertDialog.Builder(this)
            .setTitle(tr("允许 AI 填写「${request.hint}」？", "Allow the AI to fill in “${request.hint}”?"))
            .setSingleChoiceItems(entries.map { "${it.label}  ·  ${it.username}" }.toTypedArray(), chosen) { _, which -> chosen = which }
            .setPositiveButton(tr("允许填写", "Allow filling")) { _, _ ->
                AlertDialog.Builder(this)
                    .setTitle(tr("确认", "Confirm"))
                    .setMessage(tr("$where\n\n将使用「${entries[chosen].label}」。只在你认得的登录页面上允许；密码会被直接输入电脑，AI 看不到。10 分钟内同一账号不再询问。", "$where\n\nWill use “${entries[chosen].label}”. Only allow this on a login page you recognize; the password is typed straight into the computer and the AI never sees it. It won’t ask again for this account for 10 minutes."))
                    .setPositiveButton(tr("确认允许", "Confirm and allow")) { _, _ -> answer(current, request, entries[chosen]) }
                    .setNegativeButton(tr("取消", "Cancel"), null)
                    .show()
            }
            .setNegativeButton(tr("拒绝", "Deny")) { _, _ -> answer(current, request, null) }
            .setNeutralButton(tr("新建账号", "New account")) { _, _ -> editEntry(VaultEntry(label = request.hint, username = "", password = "")) { approveSecret(request) } }
            .show()
    }

    private fun answer(current: HubClient, request: SecretRequest, entry: VaultEntry?) {
        work({ current.answerSecret(request.id, entry) }, { error -> toast(error.message ?: tr("失败", "Failed")) }) {
            toast(if (entry == null) tr("已拒绝", "Denied") else tr("已允许，电脑上正在填写", "Allowed; the computer is filling it in"))
            refresh()
        }
    }


    private fun showClientTokens() {
        val current = client ?: return
        val page = page()
        backTo = { showHome() }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(text("‹", 30f, INK).apply {
            setPadding(0, 0, dp(14), dp(4))
            setOnClickListener { showHome() }
        })
        header.addView(text(tr("AI 访问密钥", "AI access keys"), 24f, INK, bold = true))
        page.addView(header)
        page.addView(text(
            tr("给不同的 AI 客户端创建独立密钥。每个密钥只能看到并调用你勾选的工具；主密钥不受影响。新密钥只显示一次，请在创建后立即复制。", "Create separate keys for different AI clients. Each key can only see and call the tools you select; your main key is unchanged. A new key is shown only once, so copy it when created."),
            13f, MUTED
        ).below(12))
        var loadedTools: List<McpTool>? = null
        page.addView(primary(tr("＋ 新增访问密钥", "+ Add access key")) {
            val tools = loadedTools
            if (tools != null) {
                editClientToken(null, tools, emptyList())
            } else {
                work({ current.clientTokens() }, { error -> toast(error.message ?: tr("读取工具失败", "Couldn’t load tools")) }) { view ->
                    editClientToken(null, view.tools, emptyList())
                }
            }
        }.below(16))
        val notice = text(tr("正在读取密钥…", "Loading keys…"), 14f, MUTED).below(10)
        page.addView(notice)
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        page.addView(box)
        work({ current.clientTokens() }, { error ->
            notice.text = error.message ?: tr("读取失败", "Couldn’t load keys")
        }) { view ->
            loadedTools = view.tools
            notice.text = if (view.tokens.isEmpty()) tr("还没有单独创建的密钥。", "No separate keys yet.") else
                tr("共 " + view.tokens.size + " 个客户端密钥", view.tokens.size.toString() + " client keys")
            box.removeAllViews()
            for (entry in view.tokens) {
                val item = card().below(10)
                item.addView(text(entry.name, 16f, INK, bold = true).below(4))
                item.addView(text(
                    tr(entry.tools.size.toString() + " 个允许使用的工具", entry.tools.size.toString() + " allowed tools"),
                    13f, MUTED
                ).below(8))
                item.addView(text(entry.tools.joinToString(" · "), 12f, MUTED).below(10))
                val actions = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
                actions.addView(secondary(tr("修改权限", "Edit tools")) {
                    editClientToken(entry, view.tools, entry.tools)
                }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(8) })
                actions.addView(secondary(tr("删除", "Delete")) {
                    confirmDeleteClientToken(entry)
                }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                item.addView(actions)
                box.addView(item)
            }
        }
    }

    private fun editClientToken(existing: ClientToken?, tools: List<McpTool>, selectedTools: List<String>) {
        val current = client ?: return
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val name = EditText(this).apply {
            hint = tr("名称，例如 Claude、GPT 工作账号", "Name, e.g. Claude, GPT work account")
            setText(existing?.name.orEmpty())
            inputType = InputType.TYPE_CLASS_TEXT
            isSingleLine = true
        }
        form.addView(text(tr("密钥名称", "Key name"), 13f, MUTED))
        form.addView(name.below(4))
        form.addView(text(tr("允许显示和调用的工具", "Tools this key can see and call"), 14f, INK, bold = true).below(14))
        val checks = tools.map { tool ->
            val check = CheckBox(this).apply {
                text = tool.title + "  ·  " + tool.name
                textSize = 14f
                setTextColor(INK)
                isChecked = selectedTools.contains(tool.name)
                setPadding(0, dp(4), 0, dp(4))
            }
            form.addView(check)
            tool.name to check
        }
        val scroll = ScrollView(this).apply {
            addView(form)
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, dp(520))
        }
        AlertDialog.Builder(this)
            .setTitle(if (existing == null) tr("创建访问密钥", "Create access key") else tr("修改访问权限", "Edit access permissions"))
            .setView(padded(scroll))
            .setPositiveButton(tr("保存", "Save")) { _, _ ->
                val label = name.text.toString().trim()
                val chosen = checks.filter { it.second.isChecked }.map { it.first }
                if (label.isEmpty()) {
                    toast(tr("请填写密钥名称", "Enter a key name"))
                    return@setPositiveButton
                }
                if (chosen.isEmpty()) {
                    toast(tr("至少选择一个工具", "Select at least one tool"))
                    return@setPositiveButton
                }
                if (existing == null) {
                    work({ current.createClientToken(label, chosen) }, { error ->
                        toast(error.message ?: tr("创建失败", "Couldn’t create key"))
                    }) { issued ->
                        showIssuedClientToken(issued)
                    }
                } else {
                    work({ current.updateClientToken(existing.id, label, chosen) }, { error ->
                        toast(error.message ?: tr("保存失败", "Couldn’t save permissions"))
                    }) {
                        toast(tr("权限已更新", "Permissions updated"))
                        showClientTokens()
                    }
                }
            }
            .setNegativeButton(tr("取消", "Cancel"), null)
            .show()
    }

    private fun showIssuedClientToken(issued: IssuedClientToken) {
        val host = connection?.host ?: return
        val fullUrl = "https://" + host + "/t/" + issued.key + "/mcp"
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        body.addView(text(
            tr("这是新密钥的唯一显示机会。复制并添加到对应 AI 客户端；离开此窗口后无法再次查看密钥，只能删除并重新创建。", "This is the only time the new key will be shown. Copy it into the intended AI client. After closing this window, the secret cannot be viewed again; delete and recreate it if lost."),
            13f, MUTED
        ).below(12))
        val baseUrl = "https://" + host + "/mcp"
        body.addView(text(tr("MCP 地址（直接粘贴到 AI 客户端）", "MCP URL (paste directly into the AI client)"), 13f, INK, bold = true).below(4))
        body.addView(text(fullUrl, 12f, BLUE).apply { setTextIsSelectable(true) }.below(8))
        body.addView(secondary(tr("复制完整 MCP 地址", "Copy full MCP URL")) {
            copy(tr("MCP 地址", "MCP URL"), fullUrl, sensitive = true)
        }.below(12))
        body.addView(text(tr("需要分开填写网址和 Bearer 密钥时，使用下面两项：", "For clients that need a separate URL and Bearer key, use these two items:"), 12f, MUTED).below(6))
        body.addView(text(tr("基础网址", "Base URL"), 13f, INK, bold = true).below(4))
        body.addView(text(baseUrl, 12f, BLUE).apply { setTextIsSelectable(true) }.below(6))
        body.addView(secondary(tr("复制基础网址", "Copy base URL")) {
            copy(tr("基础网址", "Base URL"), baseUrl, sensitive = true)
        }.below(10))
        body.addView(text(tr("Bearer 密钥", "Bearer key"), 13f, INK, bold = true).below(4))
        body.addView(text(issued.key, 12f, INK).apply { setTextIsSelectable(true) }.below(6))
        body.addView(secondary(tr("复制密钥", "Copy secret")) {
            copy(tr("密钥", "Secret key"), issued.key, sensitive = true)
        }.below(8))
        AlertDialog.Builder(this)
            .setTitle(tr("密钥已创建", "Access key created"))
            .setView(padded(body))
            .setPositiveButton(tr("完成", "Done")) { _, _ -> showClientTokens() }
            .show()
    }

    private fun confirmDeleteClientToken(entry: ClientToken) {
        val current = client ?: return
        AlertDialog.Builder(this)
            .setTitle(tr("删除访问密钥？", "Delete access key?"))
            .setMessage(
                tr("删除「" + entry.name + "」后，使用它的 AI 客户端会立即失去访问权限。这个操作无法撤销。",
                   "Deleting “" + entry.name + "” immediately revokes access for any AI client using it. This cannot be undone.")
            )
            .setPositiveButton(tr("删除", "Delete")) { _, _ ->
                work({ current.deleteClientToken(entry.id) }, { error ->
                    toast(error.message ?: tr("删除失败", "Couldn’t delete key"))
                }) {
                    toast(tr("密钥已撤销", "Access key revoked"))
                    showClientTokens()
                }
            }
            .setNegativeButton(tr("取消", "Cancel"), null)
            .show()
    }

    private fun showVault() {
        val page = page()
        backTo = { showHome() }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(text("‹", 30f, INK).apply {
            setPadding(0, 0, dp(14), dp(4))
            setOnClickListener { showHome() }
        })
        header.addView(text(tr("密码库", "Password vault"), 24f, INK, bold = true))
        page.addView(header)
        page.addView(text(tr("只加密保存在这部手机上，不会上传。AI 每次要用都会先问你，它只能让电脑把密码填进去，自己看不到。", "Stored encrypted on this phone only and never uploaded. The AI asks you every time it needs one, and it can only have the computer type the password in; it never sees it."), 13f, MUTED).below(8))
        val entries = vault.load()
        if (entries.isEmpty()) page.addView(text(tr("还没有保存的账号。", "No saved accounts yet."), 14f, MUTED).below(16))
        for (entry in entries) {
            val row = card().below(10)
            row.addView(text(entry.label, 16f, INK, bold = true))
            row.addView(text(entry.username.ifEmpty { tr("（没有账号名）", "(no account name)") } + "  ·  ••••••", 13f, MUTED).below(3))
            row.setOnClickListener { editEntry(entry) { showVault() } }
            page.addView(row)
        }
        page.addView(primary(tr("＋ 添加账号", "+ Add account")) { editEntry(VaultEntry(label = "", username = "", password = "")) { showVault() } }.below(16))
    }

    private fun editEntry(entry: VaultEntry, after: () -> Unit) {
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val label = EditText(this).apply { setText(entry.label); hint = tr("名称，比如 GitHub、公司邮箱", "Name, e.g. GitHub, work email") }
        val username = EditText(this).apply { setText(entry.username); hint = tr("账号", "username"); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS }
        val password = EditText(this).apply { setText(entry.password); hint = tr("密码", "password"); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        form.addView(label)
        form.addView(username)
        form.addView(password)
        val known = vault.load().any { it.id == entry.id }
        val dialog = AlertDialog.Builder(this)
            .setTitle(if (known) tr("编辑账号", "Edit account") else tr("添加账号", "Add account"))
            .setView(padded(form))
            .setPositiveButton(tr("保存", "Save")) { _, _ ->
                val name = label.text.toString().trim()
                if (name.isEmpty()) {
                    toast(tr("请填写名称", "Please enter a name"))
                    return@setPositiveButton
                }
                vault.put(entry.copy(label = name, username = username.text.toString(), password = password.text.toString()))
                toast(tr("已保存", "Saved"))
                after()
            }
            .setNegativeButton(tr("取消", "Cancel"), null)
        if (known) dialog.setNeutralButton(tr("删除", "Delete")) { _, _ ->
            vault.remove(entry.id)
            toast(tr("已删除", "Deleted"))
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
        page.addView(text((if (computer.online) tr("● 在线", "● Online") + viaLabel(computer) else tr("● 离线", "● Offline")) + "  ·  " + computer.os, 14f, if (computer.online) GREEN else GRAY).below(4))
        if (!computer.main && computer.route != "public" && computer.lanProblem != null && (computer.route == "lan" || !computer.online || computer.via != "lan")) {
            page.addView(text(tr("局域网：", "LAN: ") + computer.lanProblem, 13f, MUTED).below(4))
        }
        if (computer.takeover != null) page.addView(takeoverBanner(computer).below(14))

        val browser = card().below(16)
        browser.addView(text(tr("浏览器", "Browser"), 17f, INK, bold = true))
        // A computer without a desktop (a Linux VM or server) still has the AI's own browser to show.
        if (!computer.desktop && !computer.browser) {
            browser.addView(text(tr("这台电脑看不到浏览器：没有桌面控制，也没装 AI 浏览器。Windows 电脑在 Computer MCP 里点“安装桌面控制”；Linux 电脑运行 computer-mcp browser。", "This computer’s browser can’t be seen: it has no desktop control and no AI browser. On Windows, tap “Install desktop control” in Computer MCP; on Linux, run computer-mcp browser."), 14f, MUTED).below(8))
        } else {
            val preview = ImageView(this).apply {
                scaleType = ImageView.ScaleType.FIT_CENTER
                setBackgroundColor(NIGHT)
                setOnClickListener { showTakeover(computer) }
            }
            browser.addView(preview, LinearLayout.LayoutParams(MATCH_PARENT, dp(210)).apply { topMargin = dp(10) })
            val line = text(tr("正在读取浏览器画面…", "Loading the browser view…"), 13f, MUTED).below(8)
            browser.addView(line)
            line.maxLines = 1
            line.ellipsize = TextUtils.TruncateAt.END
            browser.addView(primary(tr("打开浏览器 ↗", "Open browser ↗")) { showTakeover(computer) }.below(10))
            browser.addView(secondary(tr("选择浏览器窗口", "Choose a browser window")) { pickWindow(computer) { line.text = tr("已选择：$it", "Selected: $it") } }.below(8))
            fun load() {
                val current = client ?: return
                if (token != screenToken) return
                work({ current.browserFrame(computer.id) }, { error ->
                    if (token == screenToken) {
                        line.text = if ((error as? HubException)?.needsPick == true) tr("还没选择窗口。点“选择浏览器窗口”", "No window chosen yet. Tap “Choose a browser window”") else error.message
                        main.postDelayed({ load() }, PREVIEW_MS)
                    }
                }) { frame ->
                    if (token != screenToken) return@work
                    BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size)?.let { preview.setImageBitmap(it) }
                    line.text = frame.title.ifEmpty { tr("浏览器", "Browser") }
                    main.postDelayed({ load() }, PREVIEW_MS)
                }
            }
            if (computer.online) load() else line.text = tr("电脑离线，看不到画面", "The computer is offline; no picture available")
        }
        page.addView(browser)

        val settings = card().below(16)
        settings.addView(text(tr("设置", "Settings"), 17f, INK, bold = true))
        settings.addView(secondary(tr("改名 · 写用途 · 移除", "Rename · describe · remove")) { editComputer(currentComputer(computer.id) ?: computer) }.below(10))
        if (!computer.main) {
            settings.addView(secondary(tr("连接方式：", "Connection: ") + routeLabel(computer.route)) { chooseRoute(currentComputer(computer.id) ?: computer) }.below(8))
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
        val state = text(tr("正在连接…", "Connecting…"), 12f, 0xFF9CA3AF.toInt()).apply {
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
        for ((key, label) in listOf("tap" to tr("点按", "Tap"), "drag" to tr("拖动", "Drag"), "scroll" to tr("滚动", "Scroll"))) {
            modeButtons[key] = control(label) {
                takeoverMode = key
                screen.mode = key
                paintModes()
            }
        }
        paintModes()
        val keyButtons = listOf(tr("键盘", "Keyboard") to "", tr("回车", "Enter") to "enter", tr("退格", "Backspace") to "backspace", "Tab" to "tab", "Esc" to "esc").map { (label, key) ->
            control(label) {
                if (key.isEmpty()) askToType { typed -> send(JSONObject().put("action", "type").put("text", typed)) }
                else send(JSONObject().put("action", "key").put("keys", key))
            }
        }
        val fitButton = control(tr("复位", "Reset")) { screen.fit() }
        val rotateButton = control(if (landscape) tr("竖屏", "Portrait") else tr("横屏", "Landscape")) {
            takeoverOrientation = if (landscape) ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            requestedOrientation = takeoverOrientation
        }
        val finishButton = control(tr("完成 · 交还给 AI", "Done · hand back to AI"), GREEN) {
            work({ current.browserFinish(computer.id) }, { error -> toast(error.message ?: tr("失败", "Failed")) }) {
                // Clear the request here too, so the page shown next has no stale banner.
                status = status?.let { s -> s.copy(computers = s.computers.map { if (it.id == computer.id) it.copy(takeover = null) else it }) }
                toast(tr("已交还给 AI", "Handed back to the AI"))
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
            column.addView(finishButton.apply { text = tr("交还 AI", "Hand back") }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(10) })
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
            heading.addView(text(tr("${computer.name} 的浏览器", "${computer.name}’s browser"), 16f, Color.WHITE, bold = true).apply { maxLines = 1 })
            heading.addView(state)
            top.addView(heading, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            top.addView(rotateButton, LinearLayout.LayoutParams(dp(72), WRAP_CONTENT))
            root.addView(top)
            root.addView(screen, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f).apply { topMargin = dp(6) })
            root.addView(text(tr("单指：点按 / 长按右键 / 滑动滚动　双指：缩放、移动画面", "One finger: tap / long-press for right-click / swipe to scroll. Two fingers: zoom and pan"), 12f, 0xFF9CA3AF.toInt()).apply {
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
                    state.text = tr("先选择要接管的浏览器窗口", "Choose the browser window to take over first")
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
        work({ current.browserWindows(computer.id) }, { error -> toast(error.message ?: tr("读取窗口失败", "Couldn’t read windows")) }) { windows ->
            if (windows.isEmpty()) {
                toast(tr("${computer.name} 上没有打开的浏览器。先打开 Chrome、Edge 或 Firefox", "No browser is open on ${computer.name}. Open Chrome, Edge or Firefox first"))
                return@work
            }
            val labels = windows.map { w ->
                val title = if (w.title.length > 60) w.title.take(60) + "…" else w.title
                title + (if (w.automation) tr("\n（AI 自动化用的浏览器，最好别动）", "\n(The browser the AI automates; best left alone)") else "") + (if (w.minimized) tr("（已最小化）", " (minimized)") else "")
            }
            AlertDialog.Builder(this)
                .setTitle(tr("选择 ${computer.name} 上的浏览器窗口", "Choose a browser window on ${computer.name}"))
                .setItems(labels.toTypedArray()) { _, which ->
                    val window = windows[which]
                    work({ current.browserSelect(computer.id, window.hwnd) }, { error -> toast(error.message ?: tr("选择失败", "Couldn’t choose")) }) { onPicked(window.title) }
                }
                .setNegativeButton(tr("取消", "Cancel"), null)
                .show()
        }
    }

    private fun askToType(onText: (String) -> Unit) {
        val input = EditText(this).apply { hint = tr("要输入的文字", "Text to type") }
        AlertDialog.Builder(this)
            .setTitle(tr("输入到电脑浏览器", "Type into the computer’s browser"))
            .setView(padded(input))
            .setPositiveButton(tr("发送", "Send")) { _, _ -> input.text.toString().takeIf { it.isNotEmpty() }?.let(onText) }
            .setNegativeButton(tr("取消", "Cancel"), null)
            .show()
    }

    private fun copyPart(label: String, pick: (HubStatus) -> String) {
        val current = status
        if (current == null) {
            toast(tr("正在连接主电脑，请稍等", "Connecting to the main computer, please wait"))
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
        toast(tr("已复制$label", "Copied $label"))
    }

    private fun addComputer() {
        val current = client ?: return
        work({ current.invite() }, { error -> toast(error.message ?: tr("生成失败", "Couldn’t generate")) }) { invite -> showInvite(invite) }
    }

    private fun showInvite(invite: Invite) {
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        body.addView(text(tr("1. 在新电脑上安装并打开 Computer MCP", "1. Install and open Computer MCP on the new computer"), 15f, INK))
        body.addView(text(tr("2. 把下面的配对码发到新电脑，粘贴后点“加入主电脑”", "2. Send the pairing code below to the new computer, paste it and tap “Join main computer”"), 15f, INK).below(8))
        body.addView(text(invite.pair, 17f, BLUE, bold = true).apply {
            setTextIsSelectable(true)
            typeface = Typeface.MONOSPACE
            setPadding(0, dp(16), 0, dp(12))
        })
        body.addView(text(tr("${invite.minutes} 分钟内有效，只能用一次。加入成功后这个窗口会自动关闭。", "Valid for ${invite.minutes} minutes and works once. This window closes automatically after joining."), 13f, MUTED))
        pairDialog = AlertDialog.Builder(this)
            .setTitle(tr("添加电脑", "Add computer"))
            .setView(padded(body))
            .setPositiveButton(tr("复制配对码", "Copy pairing code")) { _, _ -> copy(tr("配对码", "Pairing code"), invite.pair) }
            .setNeutralButton(tr("发送到…", "Send to…")) { _, _ ->
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, invite.pair)
                }, tr("发送配对码", "Send pairing code")))
            }
            .setNegativeButton(tr("关闭", "Close"), null)
            .show()
    }

    private fun showClientHelp() {
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val guides = listOf(
            tr("豆包", "Doubao") to tr("打开“技能·连接器”，右上角“新建”→“新建自定义连接器”。名称随便写，传输类型选 HTTP，服务器 URL 粘贴“复制 MCP 地址”的内容，Headers 留空。", "Open “Skills · Connectors”, tap “New” at the top right → “New custom connector”. Use any name, choose HTTP as the transport type, paste what “Copy MCP address” gave you into Server URL, and leave Headers empty."),
            "ChatGPT" to tr("在设置的“应用/连接器”里打开开发者模式，新建连接器，URL 粘贴“复制 MCP 地址”的内容，认证选“无”。", "In Settings → “Apps/Connectors”, turn on developer mode, create a connector, paste what “Copy MCP address” gave you into URL, and set authentication to “None”."),
            "Claude" to tr("设置 →“连接器”→“添加自定义连接器”，URL 粘贴“复制 MCP 地址”的内容。", "Settings → “Connectors” → “Add custom connector”, then paste what “Copy MCP address” gave you into URL."),
            tr("其他软件", "Other apps") to tr("只能填一个网址的，用“复制 MCP 地址”；要分开填网址和 Bearer 令牌的，分别用“只复制网址”和“只复制密钥”。", "If the app takes a single URL, use “Copy MCP address”. If it wants the URL and a Bearer token separately, use “Copy URL only” and “Copy key only”."),
        )
        for ((name, steps) in guides) {
            body.addView(text(name, 16f, INK, bold = true).below(12))
            body.addView(text(steps, 14f, INK).below(4))
        }
        body.addView(text(tr("加了新电脑后，如果 AI 说找不到 computer 参数，在 AI 软件里刷新一下这个连接器。", "After adding a new computer, if the AI says it can’t find the computer parameter, refresh this connector in the AI app."), 13f, MUTED).below(14))
        AlertDialog.Builder(this)
            .setTitle(tr("接入 AI 软件", "Connect an AI app"))
            .setView(ScrollView(this).apply { addView(padded(body)) })
            .setPositiveButton(tr("复制 MCP 地址", "Copy MCP address")) { _, _ -> copyPart(tr("MCP 地址", "MCP address")) { it.full } }
            .setNegativeButton(tr("关闭", "Close"), null)
            .show()
    }

    private fun viaLabel(computer: Computer): String = when (computer.via) {
        "lan" -> tr("（局域网）", " (LAN)")
        "public" -> tr("（公网）", " (internet)")
        else -> ""
    }

    private fun routeLabel(route: String): String = when (route) {
        "lan" -> tr("只用局域网", "LAN only")
        "public" -> tr("只用公网", "Internet only")
        else -> tr("自动", "Automatic")
    }

    /** auto prefers the LAN and falls back; the other two never switch, and say so when they cannot work. */
    private fun chooseRoute(computer: Computer) {
        val current = client ?: return
        val routes = arrayOf("auto", "lan", "public")
        val labels = arrayOf(tr("自动（优先局域网，不通就走公网）", "Automatic (prefer LAN, fall back to the internet)"), tr("只用局域网（连不上就报错）", "LAN only (error if it can’t connect)"), tr("只用公网", "Internet only"))
        AlertDialog.Builder(this)
            .setTitle(tr("${computer.name} 的连接方式", "Connection for ${computer.name}"))
            .setSingleChoiceItems(labels, routes.indexOf(computer.route).coerceAtLeast(0)) { dialog, which ->
                dialog.dismiss()
                if (routes[which] == computer.route) return@setSingleChoiceItems
                work({ current.setRoute(computer.id, routes[which]) }, { error -> toast(error.message ?: tr("保存失败", "Couldn’t save")) }) {
                    toast(tr("已改为", "Changed to") + routeLabel(routes[which]))
                    refresh()
                }
            }
            .setNegativeButton(tr("取消", "Cancel"), null)
            .show()
    }

    private fun editComputer(computer: Computer) {
        val current = client ?: return
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val name = EditText(this).apply {
            setText(computer.name)
            hint = tr("名字", "Name")
            inputType = InputType.TYPE_CLASS_TEXT
            isEnabled = !computer.main
        }
        val note = EditText(this).apply {
            setText(computer.note)
            hint = tr("用途，比如：工作室，装了 Blender", "Purpose, e.g. studio with Blender installed")
            inputType = InputType.TYPE_CLASS_TEXT
        }
        form.addView(text(tr("名字", "Name"), 13f, MUTED))
        form.addView(name)
        form.addView(text(tr("用途（AI 靠它决定用哪台电脑）", "Purpose (the AI uses it to pick a computer)"), 13f, MUTED).below(10))
        form.addView(note)
        val builder = AlertDialog.Builder(this)
            .setTitle(computer.name)
            .setView(padded(form))
            .setPositiveButton(tr("保存", "Save")) { _, _ ->
                val newName = if (computer.main) null else name.text.toString().trim()
                work({ current.update(computer.id, newName, note.text.toString().trim()) }, { error -> toast(error.message ?: tr("保存失败", "Couldn’t save")) }) {
                    toast(tr("已保存", "Saved"))
                    refresh()
                }
            }
            .setNegativeButton(tr("取消", "Cancel"), null)
        if (!computer.main) builder.setNeutralButton(tr("移除", "Remove")) { _, _ -> confirmRemove(computer) }
        builder.show()
    }

    private fun confirmRemove(computer: Computer) {
        val current = client ?: return
        AlertDialog.Builder(this)
            .setTitle(tr("移除 ${computer.name}？", "Remove ${computer.name}?"))
            .setMessage(tr("移除后 AI 不能再控制这台电脑。要再加回来，需要重新配对。", "After removal the AI can’t control this computer any more. To add it back you need to pair it again."))
            .setPositiveButton(tr("移除", "Remove")) { _, _ ->
                work({ current.remove(computer.id) }, { error -> toast(error.message ?: tr("移除失败", "Couldn’t remove")) }) {
                    toast(tr("已移除", "Removed"))
                    refresh()
                }
            }
            .setNegativeButton(tr("取消", "Cancel"), null)
            .show()
    }

    private fun confirmForget() {
        AlertDialog.Builder(this)
            .setTitle(tr("断开这部手机？", "Disconnect this phone?"))
            .setMessage(tr("只是这部手机不再管理电脑。AI 仍能通过 MCP 地址控制电脑。", "This only stops this phone from managing your computers. The AI can still control them through the MCP address."))
            .setPositiveButton(tr("断开", "Disconnect")) { _, _ -> forget() }
            .setNegativeButton(tr("取消", "Cancel"), null)
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
            cornerRadius = dp(16).toFloat()
            setStroke(dp(1), 0xFFE5E7EB.toInt())
        }
        elevation = dp(2).toFloat()
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
        // Ripple in a contrasting tone, clipped to the same rounded shape.
        val dark = Color.red(fill) * 0.299 + Color.green(fill) * 0.587 + Color.blue(fill) * 0.114 < 128
        background = RippleDrawable(
            ColorStateList.valueOf(if (dark) 0x40FFFFFF else 0x1A000000),
            GradientDrawable().apply {
                setColor(fill)
                cornerRadius = dp(12).toFloat()
            },
            GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(12).toFloat()
            },
        )
        // A small press-in and a soft bounce back, so a tap feels answered.
        setOnTouchListener { view, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    view.animate().cancel()
                    view.animate().scaleX(0.96f).scaleY(0.96f).setDuration(90)
                        .setInterpolator(DecelerateInterpolator()).start()
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    view.animate().cancel()
                    view.animate().scaleX(1f).scaleY(1f).setDuration(240)
                        .setInterpolator(OvershootInterpolator(2.2f)).start()
                }
            }
            false
        }
        setOnClickListener {
            performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
            onClick()
        }
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
    }
}
