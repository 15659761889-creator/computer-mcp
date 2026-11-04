package com.computermcp.app

import android.content.Context
import java.util.Locale

/**
 * Interface language. It follows the phone's language (Chinese phones get Chinese, everything else
 * gets English) unless the person picks one on the home screen.
 */
object Lang {
    const val AUTO = "auto"
    const val ZH = "zh"
    const val EN = "en"

    private const val FILE = "computer_mcp_ui"
    private const val KEY = "language"

    @Volatile
    private var pref = AUTO

    /** Call once per process entry point (activity, service, receiver) before any text is built. */
    fun init(context: Context) {
        pref = try {
            context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, AUTO) ?: AUTO
        } catch (_: Exception) {
            AUTO
        }
    }

    val setting: String get() = pref

    fun set(context: Context, value: String) {
        pref = if (value == ZH || value == EN) value else AUTO
        try {
            context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY, pref).apply()
        } catch (_: Exception) {
        }
    }

    val english: Boolean
        get() = when (pref) {
            EN -> true
            ZH -> false
            else -> Locale.getDefault().language != "zh"
        }

    /** Sent to the computer so the messages it writes come back in the same language. */
    val code: String get() = if (english) EN else ZH
}

/** Picks the Chinese or the English text for the language in use. */
fun tr(zh: String, en: String): String = if (Lang.english) en else zh
