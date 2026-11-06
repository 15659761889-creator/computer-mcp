package com.wanji.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

private const val CHANNEL_WAITING = "waiting"
private const val CHANNEL_ALERTS = "alerts"
private const val ONGOING_ID = 1

/**
 * Most phones in China have no Google push, so the app keeps one long poll open to the main
 * computer and raises a notification the moment the AI needs the person.
 */
class PushService : Service() {
    @Volatile private var running = false
    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Lang.init(this)
        channels(this)
        val ongoing = NotificationCompat.Builder(this, CHANNEL_WAITING)
            .setSmallIcon(R.drawable.ic_fg)
            .setContentTitle(tr("万机", "Wanji"))
            .setContentText(tr("正在等待 AI 的请求", "Waiting for the AI’s requests"))
            .setOngoing(true)
            .setContentIntent(openApp(this, 0))
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(ONGOING_ID, ongoing)
        if (!running) {
            running = true
            worker = Thread({ loop() }, "push").apply { start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        super.onDestroy()
    }

    private fun loop() {
        var since = -1
        var shown = emptySet<String>()
        while (running) {
            val connection = ConnectionStore(this).load()
            if (connection == null) {
                stopSelf()
                return
            }
            val client = HubClient(connection)
            try {
                val version = client.waitForEvent(since)
                if (version == since) continue
                since = version
                val status = client.status()
                val now = mutableSetOf<String>()
                for (computer in status.computers) {
                    val title = computer.takeover ?: continue
                    val key = "t:${computer.id}"
                    now += key
                    if (key !in shown) alert(key, tr("AI 请你接管 ${computer.name} 的浏览器", "The AI asks you to take over the browser on ${computer.name}"), tr("可能要过人机验证或扫码登录：$title", "May need a human check or QR login: $title"))
                }
                for (request in status.secretRequests) {
                    val key = "s:${request.id}"
                    now += key
                    val part = if (request.part == "username") tr("账号", "username") else tr("密码", "password")
                    if (key !in shown) alert(key, tr("AI 想在 ${request.computer} 上填写「${request.hint}」的$part", "The AI wants to fill in the $part for “${request.hint}” on ${request.computer}"), request.reason.ifEmpty { tr("点开选择要用的账号", "Tap to choose the account to use") })
                }
                // Requests that were handled elsewhere no longer need their notification.
                for (gone in shown - now) NotificationManagerCompat.from(this).cancel(gone.hashCode())
                shown = now
            } catch (error: HubException) {
                if (error.unauthorized) {
                    stopSelf()
                    return
                }
                pause(15000)
            } catch (_: Exception) {
                pause(15000)
            }
        }
    }

    private fun pause(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            running = false
        }
    }

    private fun alert(key: String, title: String, text: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val notification = NotificationCompat.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_fg)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(openApp(this, key.hashCode()))
            .build()
        NotificationManagerCompat.from(this).notify(key.hashCode(), notification)
    }

    companion object {
        private const val PREFS = "push"

        fun enabled(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("on", true)

        fun setEnabled(context: Context, on: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("on", on).apply()
            if (on) start(context) else context.stopService(Intent(context, PushService::class.java))
        }

        fun start(context: Context) {
            if (!enabled(context) || ConnectionStore(context).load() == null) return
            try {
                ContextCompat.startForegroundService(context, Intent(context, PushService::class.java))
            } catch (_: Exception) {
                // Android refuses when the app is not allowed to start in the background; the app tries again when opened.
            }
        }

        fun stop(context: Context) = context.stopService(Intent(context, PushService::class.java))

        fun channels(context: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL_WAITING, tr("后台等待", "Background waiting"), NotificationManager.IMPORTANCE_MIN).apply {
                description = tr("保持连接，以便及时收到 AI 的请求", "Keeps the connection open so you get the AI’s requests promptly")
            })
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ALERTS, tr("AI 请求", "AI requests"), NotificationManager.IMPORTANCE_HIGH).apply {
                description = tr("AI 需要你接管浏览器或允许使用保存的账号", "The AI needs you to take over the browser or allow a saved account")
            })
        }

        private fun openApp(context: Context, code: Int): PendingIntent = PendingIntent.getActivity(
            context,
            code,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}

/** Brings the waiting service back after the phone restarts. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) PushService.start(context)
    }
}
