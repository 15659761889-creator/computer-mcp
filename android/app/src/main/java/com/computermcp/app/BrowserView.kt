package com.computermcp.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.widget.ImageView
import org.json.JSONObject
import kotlin.math.hypot
import kotlin.math.min

/**
 * The computer's browser on the phone. One finger acts on the computer (tap, long press, drag,
 * swipe); two fingers zoom and move the picture, so small buttons can be hit precisely.
 */
class BrowserView(context: Context) : ImageView(context) {
    /** tap, drag (for sliders) or scroll. */
    var mode = "tap"
    var onAction: (JSONObject) -> Unit = {}

    private val shown = Matrix()
    private var fitScale = 1f
    private var multi = false
    private var downX = 0f
    private var downY = 0f
    private var downTime = 0L
    private var midX = 0f
    private var midY = 0f
    private val density = resources.displayMetrics.density
    private val slop = 12 * density
    private var markX = 0f
    private var markY = 0f
    private var markUntil = 0L
    private val markPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3 * density
        color = 0xFF38BDF8.toInt()
    }

    private val scaler = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val now = currentScale()
            val factor = (now * detector.scaleFactor).coerceIn(fitScale, fitScale * 6) / now
            shown.postScale(factor, factor, detector.focusX, detector.focusY)
            settle()
            return true
        }
    })

    init {
        scaleType = ScaleType.MATRIX
        setBackgroundColor(0xFF000000.toInt())
    }

    /** Shows a new frame; the zoom stays unless the picture changed size. */
    fun setFrame(bitmap: Bitmap) {
        val old = drawable
        val sameSize = old != null && old.intrinsicWidth == bitmap.width && old.intrinsicHeight == bitmap.height
        setImageBitmap(bitmap)
        if (sameSize) {
            imageMatrix = shown
        } else {
            fit()
            // Right after a rotation the view may not be measured yet; fit again once it is.
            post { fit() }
        }
    }

    /** Back to the whole picture. */
    fun fit() {
        val picture = drawable ?: return
        if (width == 0 || height == 0) return
        val w = picture.intrinsicWidth.toFloat()
        val h = picture.intrinsicHeight.toFloat()
        fitScale = min(width / w, height / h)
        shown.setScale(fitScale, fitScale)
        shown.postTranslate((width - w * fitScale) / 2f, (height - h * fitScale) / 2f)
        imageMatrix = shown
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        fit()
    }

    private fun currentScale(): Float {
        val values = FloatArray(9)
        shown.getValues(values)
        return values[Matrix.MSCALE_X]
    }

    // Keeps the picture on screen: centred while smaller than the view, edge to edge once larger.
    private fun settle() {
        val picture = drawable ?: return
        val rect = RectF(0f, 0f, picture.intrinsicWidth.toFloat(), picture.intrinsicHeight.toFloat())
        shown.mapRect(rect)
        fun shift(start: Float, end: Float, size: Float, room: Int) = when {
            size <= room -> (room - size) / 2 - start
            start > 0 -> -start
            end < room -> room - end
            else -> 0f
        }
        shown.postTranslate(shift(rect.left, rect.right, rect.width(), width), shift(rect.top, rect.bottom, rect.height(), height))
        imageMatrix = shown
    }

    // Where a point on the view falls on the computer's window, from 0 to 1 in each direction.
    private fun spot(x: Float, y: Float): Pair<Double, Double>? {
        val picture = drawable ?: return null
        val inverse = Matrix()
        if (!shown.invert(inverse)) return null
        val point = floatArrayOf(x, y)
        inverse.mapPoints(point)
        val nx = point[0] / picture.intrinsicWidth
        val ny = point[1] / picture.intrinsicHeight
        return if (nx in 0f..1f && ny in 0f..1f) nx.toDouble() to ny.toDouble() else null
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaler.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                multi = false
                downX = event.x
                downY = event.y
                downTime = event.eventTime
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                multi = true
                midX = (event.getX(0) + event.getX(1)) / 2
                midY = (event.getY(0) + event.getY(1)) / 2
            }
            MotionEvent.ACTION_MOVE -> if (multi && event.pointerCount >= 2) {
                val x = (event.getX(0) + event.getX(1)) / 2
                val y = (event.getY(0) + event.getY(1)) / 2
                shown.postTranslate(x - midX, y - midY)
                midX = x
                midY = y
                settle()
            }
            MotionEvent.ACTION_UP -> if (!multi) act(event)
        }
        return true
    }

    private fun act(event: MotionEvent) {
        val start = spot(downX, downY) ?: return
        val end = spot(event.x, event.y) ?: start
        val moved = hypot(event.x - downX, event.y - downY)
        val action = JSONObject()
        when {
            mode == "drag" && moved > slop -> action.put("action", "drag").put("x", start.first).put("y", start.second)
                .put("to_x", end.first).put("to_y", end.second)
            mode == "scroll" || moved > slop * 2 -> {
                // Finger up moves the page up, like scrolling on the phone itself; negative is down.
                val notches = ((event.y - downY) / height * 14).toInt().coerceIn(-10, 10)
                action.put("action", "scroll").put("x", start.first).put("y", start.second)
                    .put("amount", if (notches != 0) notches else if (event.y >= downY) 1 else -1)
            }
            event.eventTime - downTime > 600 -> action.put("action", "right_click").put("x", start.first).put("y", start.second)
            else -> action.put("action", "click").put("x", start.first).put("y", start.second)
        }
        markX = downX
        markY = downY
        markUntil = System.currentTimeMillis() + 450
        invalidate()
        postInvalidateDelayed(460)
        onAction(action)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (System.currentTimeMillis() < markUntil) canvas.drawCircle(markX, markY, 16 * density, markPaint)
    }
}
