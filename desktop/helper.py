"""Desktop perception and control for Computer MCP (Windows).

Stays running with the OCR model warm and answers JSON lines on stdin/stdout.
All coordinates are physical screen pixels: the process is per-monitor DPI aware,
so screenshots, UI Automation rectangles and mouse input all share one system.
"""
import base64
import ctypes
import json
import re
import sys
import threading
import time
import traceback
import unicodedata
import zlib
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
# Must happen before anything creates a window or reads a metric.
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

sys.coinit_flags = 0  # Multithreaded COM, so a blocking Invoke can run on its own thread.
import comtypes  # noqa: E402
import comtypes.client  # noqa: E402
import cv2  # noqa: E402
import mss  # noqa: E402
import numpy as np  # noqa: E402

comtypes.client.GetModule("UIAutomationCore.dll")
from comtypes.gen import UIAutomationClient as UIA  # noqa: E402

MAX_ELEMENTS = 400
MAX_NAME_CHARS = 80
IMAGE_LONG_SIDE = 1568
OCR_MARGIN = 2
CHANGE_PIXEL_THRESHOLD = 12
CHANGE_RATIO = 0.0004
SETTLE_MS = 120
DEFAULT_ACT_TIMEOUT_MS = 1500
NO_CHANGE_GIVE_UP_MS = 700
INVOKE_TIMEOUT_S = 1.5
INVOKE_NO_CHANGE_MS = 450
FEW_ELEMENTS = 3
LONE_CHAR_MIN_SCORE = 0.85
# Windows 11 Notepad loses characters below 20 ms apart (measured), so this leaves a margin.
TYPE_DELAY_S = 0.025
CLOSE_WAIT_S = 2.0
READ_BACK_CHARS = 200000
# A gap this many line-heights wide separates two labels; word spaces are about 0.3.
LABEL_GAP = 0.55
TARGET_RETRY_MS = 1500
LOOK_SETTLE_MS = 1200

ROLE_NAMES = {
    UIA.UIA_ButtonControlTypeId: "button", UIA.UIA_CheckBoxControlTypeId: "checkbox",
    UIA.UIA_ComboBoxControlTypeId: "combobox", UIA.UIA_EditControlTypeId: "edit",
    UIA.UIA_HyperlinkControlTypeId: "link", UIA.UIA_ImageControlTypeId: "image",
    UIA.UIA_ListItemControlTypeId: "listitem", UIA.UIA_MenuItemControlTypeId: "menuitem",
    UIA.UIA_RadioButtonControlTypeId: "radio", UIA.UIA_SliderControlTypeId: "slider",
    UIA.UIA_SpinnerControlTypeId: "spinner", UIA.UIA_TabItemControlTypeId: "tab",
    UIA.UIA_TextControlTypeId: "label", UIA.UIA_TreeItemControlTypeId: "treeitem",
    UIA.UIA_DataItemControlTypeId: "dataitem", UIA.UIA_SplitButtonControlTypeId: "splitbutton",
    UIA.UIA_DocumentControlTypeId: "document", UIA.UIA_HeaderItemControlTypeId: "header",
    UIA.UIA_CustomControlTypeId: "custom", UIA.UIA_GroupControlTypeId: "group",
    UIA.UIA_PaneControlTypeId: "pane", UIA.UIA_ListControlTypeId: "list",
    UIA.UIA_MenuBarControlTypeId: "menubar", UIA.UIA_ToolBarControlTypeId: "toolbar",
    UIA.UIA_TitleBarControlTypeId: "titlebar", UIA.UIA_WindowControlTypeId: "window",
    UIA.UIA_TableControlTypeId: "table", UIA.UIA_TreeControlTypeId: "tree",
    UIA.UIA_TabControlTypeId: "tablist", UIA.UIA_MenuControlTypeId: "menu",
}
# Worth listing even with no name, because they can be acted on.
ACTIONABLE = {"button", "checkbox", "combobox", "edit", "link", "listitem", "menuitem", "radio", "slider",
              "spinner", "tab", "treeitem", "dataitem", "splitbutton", "header", "document"}
# Listed only when named and not huge; they are mostly layout.
STRUCTURAL = {"custom", "group", "pane", "list", "menubar", "toolbar", "titlebar", "window", "table", "tree", "tablist", "menu"}
# A role a click target should prefer over plain text, best first.
ROLE_RANK = {role: 0 for role in ACTIONABLE}
ROLE_RANK.update({"label": 1, "image": 1, "text": 2})

CF_UNICODETEXT = 13
WM_SYSCOMMAND = 0x0112
SC_CLOSE = 0xF060
SW_MINIMIZE, SW_MAXIMIZE, SW_RESTORE = 6, 3, 9
GA_ROOT = 2
GW_OWNER = 4
INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYUP, KEY_UNICODE, KEY_EXTENDED = 0x0002, 0x0004, 0x0001
MOUSE_MOVE, MOUSE_ABS, MOUSE_VIRTUAL = 0x0001, 0x8000, 0x4000
MOUSE_WHEEL, MOUSE_HWHEEL = 0x0800, 0x1000
BUTTONS = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010), "middle": (0x0020, 0x0040)}
SM_XVIRTUAL, SM_YVIRTUAL, SM_CXVIRTUAL, SM_CYVIRTUAL = 76, 77, 78, 79
PROCESS_QUERY_LIMITED = 0x1000
TOKEN_QUERY = 0x0008
TOKEN_ELEVATION = 20

VK = {
    "backspace": 0x08, "tab": 0x09, "enter": 0x0D, "return": 0x0D, "shift": 0x10, "ctrl": 0x11, "control": 0x11,
    "alt": 0x12, "pause": 0x13, "capslock": 0x14, "esc": 0x1B, "escape": 0x1B, "space": 0x20, "pageup": 0x21,
    "pagedown": 0x22, "end": 0x23, "home": 0x24, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "printscreen": 0x2C, "insert": 0x2D, "delete": 0x2E, "del": 0x2E, "win": 0x5B, "windows": 0x5B, "menu": 0x5D,
    ";": 0xBA, "=": 0xBB, ",": 0xBC, "-": 0xBD, ".": 0xBE, "/": 0xBF, "`": 0xC0, "[": 0xDB, "\\": 0xDC, "]": 0xDD, "'": 0xDE,
}
VK.update({f"f{i}": 0x6F + i for i in range(1, 25)})
VK.update({c: ord(c.upper()) for c in "abcdefghijklmnopqrstuvwxyz0123456789"})
UNASSIGNED_VK = 0x88
EXTENDED_VK = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5D}


class ToolFailure(Exception):
    """A refusal or failure the model should read; nothing was clicked."""


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetAncestor.restype = wintypes.HWND
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetWindow.restype = wintypes.HWND
user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
user32.WindowFromPoint.restype = wintypes.HWND
user32.WindowFromPoint.argtypes = [wintypes.POINT]
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsIconic.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.SwitchToThisWindow.argtypes = [wintypes.HWND, wintypes.BOOL]
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.OpenInputDesktop.restype = wintypes.HANDLE
user32.OpenClipboard.argtypes = [wintypes.HWND]
user32.GetClipboardData.restype = wintypes.HANDLE
user32.GetClipboardData.argtypes = [wintypes.UINT]
user32.SetClipboardData.restype = wintypes.HANDLE
user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
user32.CloseDesktop.argtypes = [wintypes.HANDLE]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.GetCurrentProcess.restype = wintypes.HANDLE
advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]


def norm(text):
    """Text as a click target compares it: width, case, spacing and punctuation do not count."""
    text = unicodedata.normalize("NFKC", text or "").casefold()
    return "".join(c for c in text if unicodedata.category(c)[0] in "LN")


# ---------------------------------------------------------------- windows

def window_text(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def window_class(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def window_pid(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def window_rect(hwnd):
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return (rect.left, rect.top, rect.right, rect.bottom)


def root_at(x, y):
    hwnd = user32.WindowFromPoint(wintypes.POINT(int(x), int(y)))
    return user32.GetAncestor(hwnd, GA_ROOT) if hwnd else None


def token_elevated(process_handle):
    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(process_handle, TOKEN_QUERY, ctypes.byref(token)):
        return None
    try:
        value = wintypes.DWORD()
        size = wintypes.DWORD()
        if not advapi32.GetTokenInformation(token, TOKEN_ELEVATION, ctypes.byref(value), ctypes.sizeof(value), ctypes.byref(size)):
            return None
        return bool(value.value)
    finally:
        kernel32.CloseHandle(token)


SELF_ELEVATED = token_elevated(kernel32.GetCurrentProcess())


def window_blocks_input(hwnd):
    """True when Windows will silently drop our input to this window: it runs elevated and we do not."""
    if SELF_ELEVATED:
        return False
    process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED, False, window_pid(hwnd))
    if not process:
        return False
    try:
        # Reading an elevated process's token from a non-elevated one is refused, which is the answer too.
        elevated = token_elevated(process)
        return elevated is None or elevated
    finally:
        kernel32.CloseHandle(process)


NOISE_CLASSES = {"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "tooltips_class32", "IME", "MSCTFIME UI", "Windows.UI.Core.CoreWindow"}


def automation_pids():
    """Processes started with a debugging port: browsers some program drives, which a person should not grab."""
    try:
        import comtypes.client
        wmi = comtypes.client.CoGetObject("winmgmts:root\\cimv2", dynamic=True)
        query = "SELECT ProcessId FROM Win32_Process WHERE CommandLine LIKE '%--remote-debugging-port%'"
        return {int(p.Properties_("ProcessId").Value) for p in wmi.ExecQuery(query)}
    except Exception:  # noqa: BLE001
        return set()


def list_windows():
    """Visible top-level windows, top of the stack first."""
    result = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        rect = window_rect(hwnd)
        if not rect or rect[2] - rect[0] <= 1 or rect[3] - rect[1] <= 1:
            return True
        # Cloaked UWP shells report as visible while being invisible.
        cloaked = wintypes.DWORD()
        try:
            ctypes.windll.dwmapi.DwmGetWindowAttribute(wintypes.HWND(hwnd), 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        except OSError:
            pass
        if cloaked.value:
            return True
        result.append(hwnd)
        return True

    user32.EnumWindows(visit, 0)
    return result


def owner_chain(hwnd):
    seen = set()
    while hwnd and hwnd not in seen:
        seen.add(hwnd)
        hwnd = user32.GetWindow(hwnd, GW_OWNER)
    return seen


def related_windows(target, windows):
    """The target plus what floats above it from the same app: menus, dialogs, popups."""
    pid = window_pid(target)
    related = []
    for hwnd in windows:
        if hwnd == target:
            related.append(hwnd)
            break
        cls = window_class(hwnd)
        if cls in NOISE_CLASSES:
            continue
        # Same-app windows with their own title are separate windows, not popups of this one.
        popup = window_pid(hwnd) == pid and not window_text(hwnd)
        if popup or target in owner_chain(hwnd) or cls == "#32768":
            related.append(hwnd)
    return related or [target]


def find_window(spec, windows):
    if isinstance(spec, int) or (isinstance(spec, str) and spec.lstrip("w:").isdigit()):
        hwnd = int(str(spec).lstrip("w:"))
        if not user32.IsWindow(hwnd):
            raise ToolFailure(f"window {spec} no longer exists")
        return hwnd
    wanted = norm(spec)
    named = [(h, window_text(h)) for h in windows if window_text(h) and window_class(h) not in NOISE_CLASSES]
    matches = [h for h, title in named if norm(title) == wanted] or [h for h, title in named if wanted in norm(title)]
    if not matches:
        # Minimized windows are not in the visible list's way, but they are visible windows too.
        raise ToolFailure(f'no window title contains "{spec}"; open windows: ' + "; ".join(title for _, title in named[:15]))
    if len(matches) > 1:
        raise ToolFailure(f'"{spec}" matches {len(matches)} windows; use the handle: ' + "; ".join(f'w:{h} "{window_text(h)}"' for h in matches[:10]))
    return matches[0]


def activate(hwnd):
    """Bring a window to the front."""
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    # Windows often refuses, so each way is tried in turn, gentlest first.
    for attempt in (_foreground_after_input, _foreground_attached, _foreground_switch, _foreground_alt):
        if user32.GetForegroundWindow() == hwnd:
            return True
        attempt(hwnd)
        for _ in range(12):
            if user32.GetForegroundWindow() == hwnd:
                return True
            time.sleep(0.01)
    return user32.GetForegroundWindow() == hwnd


def _foreground_after_input(hwnd):
    send_inputs([key_input(UNASSIGNED_VK), key_input(UNASSIGNED_VK, up=True)])
    user32.SetForegroundWindow(hwnd)


def _foreground_attached(hwnd):
    # Sharing input state with the foreground thread lifts the restriction.
    mine = kernel32.GetCurrentThreadId()
    theirs = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    user32.AttachThreadInput(mine, theirs, True)
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        user32.AttachThreadInput(mine, theirs, False)


def _foreground_switch(hwnd):
    user32.SwitchToThisWindow(hwnd, True)


def _foreground_alt(hwnd):
    # Last, because a lone Alt can open the current window's menu bar.
    send_inputs([key_input(0x12), key_input(0x12, up=True)])
    user32.SetForegroundWindow(hwnd)


def input_desktop_problem():
    desktop = user32.OpenInputDesktop(0, False, 0x0100)
    if not desktop:
        return "the screen is locked or showing a secure prompt (UAC); this session cannot see or control it"
    user32.CloseDesktop(desktop)
    return None


# ---------------------------------------------------------------- input

def virtual_screen():
    return (user32.GetSystemMetrics(SM_XVIRTUAL), user32.GetSystemMetrics(SM_YVIRTUAL),
            user32.GetSystemMetrics(SM_CXVIRTUAL), user32.GetSystemMetrics(SM_CYVIRTUAL))


def send_inputs(items):
    array = (INPUT * len(items))(*items)
    sent = user32.SendInput(len(items), array, ctypes.sizeof(INPUT))
    if sent != len(items):
        raise ToolFailure("Windows blocked the input; the target may be running as administrator, or a secure screen is active")


def mouse_input(flags, x=0, y=0, data=0):
    item = INPUT(type=INPUT_MOUSE)
    item.u.mi = MOUSEINPUT(x, y, data & 0xFFFFFFFF, flags, 0, 0)
    return item


def key_input(vk=0, up=False, scan=0, unicode_char=False):
    flags = KEYUP if up else 0
    if unicode_char:
        flags |= KEY_UNICODE
    elif vk in EXTENDED_VK:
        flags |= KEY_EXTENDED
    if not unicode_char and not scan:
        scan = user32.MapVirtualKeyW(vk, 0)
    item = INPUT(type=INPUT_KEYBOARD)
    item.u.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    return item


def absolute(x, y):
    vx, vy, vw, vh = virtual_screen()
    return (int((x - vx) * 65535 / max(1, vw - 1)), int((y - vy) * 65535 / max(1, vh - 1)))


def mouse_move(x, y):
    ax, ay = absolute(x, y)
    send_inputs([mouse_input(MOUSE_MOVE | MOUSE_ABS | MOUSE_VIRTUAL, ax, ay)])


def mouse_click(x, y, button="left", count=1):
    mouse_move(x, y)
    time.sleep(0.03)  # Hover states and some custom UIs need to see the move first.
    down, up = BUTTONS[button]
    for _ in range(count):
        send_inputs([mouse_input(down), mouse_input(up)])
        if count > 1:
            time.sleep(0.04)


def mouse_drag(x0, y0, x1, y1, button="left"):
    mouse_move(x0, y0)
    time.sleep(0.05)
    down, up = BUTTONS[button]
    send_inputs([mouse_input(down)])
    time.sleep(0.05)
    for step in range(1, 13):
        mouse_move(x0 + (x1 - x0) * step / 12, y0 + (y1 - y0) * step / 12)
        time.sleep(0.015)
    time.sleep(0.05)
    send_inputs([mouse_input(up)])


def mouse_wheel(x, y, notches, horizontal=False):
    mouse_move(x, y)
    time.sleep(0.02)
    flag = MOUSE_HWHEEL if horizontal else MOUSE_WHEEL
    # One notch at a time, like a real wheel: programs clamp a single huge event.
    direction = 1 if notches > 0 else -1
    for _ in range(int(abs(notches))):
        send_inputs([mouse_input(flag, data=direction * 120)])
        time.sleep(0.012)


def type_text(text):
    # One character at a time: newer apps such as Windows 11 Notepad read typed characters late,
    # and a batch arrives as its last character repeated.
    for ch in text:
        if ch == "\r":
            continue
        if ch in "\n\t":
            code = 0x0D if ch == "\n" else 0x09
            send_inputs([key_input(code), key_input(code, up=True)])
        else:
            encoded = ch.encode("utf-16-le")
            for i in range(0, len(encoded), 2):
                unit = int.from_bytes(encoded[i:i + 2], "little")
                send_inputs([key_input(0, scan=unit, unicode_char=True), key_input(0, up=True, scan=unit, unicode_char=True)])
        time.sleep(TYPE_DELAY_S)


def paste_text(text):
    previous = clipboard_text()
    set_clipboard_text(text)
    try:
        press_keys("ctrl+v")
        time.sleep(0.15)  # The target reads the clipboard after it gets the key.
    finally:
        set_clipboard_text(previous or "")


def open_clipboard():
    for _ in range(50):
        if user32.OpenClipboard(None):
            return
        time.sleep(0.01)
    raise ToolFailure("another program is holding the clipboard; nothing was pasted")


def clipboard_text():
    open_clipboard()
    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        pointer = kernel32.GlobalLock(handle)
        try:
            return ctypes.wstring_at(pointer) if pointer else None
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def set_clipboard_text(text):
    data = text.encode("utf-16-le") + b"\0\0"
    handle = kernel32.GlobalAlloc(0x0002, len(data))
    pointer = kernel32.GlobalLock(handle)
    ctypes.memmove(pointer, data, len(data))
    kernel32.GlobalUnlock(handle)
    open_clipboard()
    try:
        user32.EmptyClipboard()
        user32.SetClipboardData(CF_UNICODETEXT, handle)
    finally:
        user32.CloseClipboard()


def press_keys(combo):
    names = [part.strip().lower() for part in re.split(r"\+(?!$)", combo.strip()) if part.strip()]
    if not names:
        raise ToolFailure("keys is empty; example: ctrl+s")
    codes = []
    for name in names:
        if name not in VK:
            raise ToolFailure(f'unknown key "{name}"; examples: ctrl, shift, alt, win, enter, esc, tab, f5, a, 1')
        codes.append(VK[name])
    send_inputs([key_input(code) for code in codes] + [key_input(code, up=True) for code in reversed(codes)])


# ---------------------------------------------------------------- OCR

class Ocr:
    def __init__(self):
        self.engine = None
        self.error = None
        self.ready = threading.Event()
        self.lock = threading.Lock()
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        try:
            import logging

            from rapidocr import EngineType, LangDet, LangRec, ModelType, OCRVersion, RapidOCR

            logging.disable(logging.WARNING)
            # Measured on Chinese UI fixtures: small detector plus large recognizer gave the
            # best accuracy per millisecond, and the default 736 px detector drops whole rows.
            self.engine = RapidOCR(params={
                "Global.use_cls": False,
                "Global.max_side_len": 4096,
                "Global.log_level": "error",
                "Det.engine_type": EngineType.ONNXRUNTIME, "Det.lang_type": LangDet.CH, "Det.model_type": ModelType.MOBILE,
                "Det.ocr_version": OCRVersion.PPOCRV5, "Det.limit_side_len": 1600, "Det.limit_type": "max",
                "Det.box_thresh": 0.3, "Det.unclip_ratio": 1.3,
                "Rec.engine_type": EngineType.ONNXRUNTIME, "Rec.lang_type": LangRec.CH, "Rec.model_type": ModelType.SERVER,
                "Rec.ocr_version": OCRVersion.PPOCRV5,
                "EngineConfig.onnxruntime.use_dml": True,
            })
            warm = np.full((200, 600, 3), 255, np.uint8)
            cv2.putText(warm, "warm up", (20, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
            self.engine(warm)
            self.engine(warm)
        except Exception as error:  # noqa: BLE001
            self.error = f"{type(error).__name__}: {error}"
            print(traceback.format_exc(), file=sys.stderr, flush=True)
        self.ready.set()

    def read(self, bgr, offset=(0, 0)):
        self.ready.wait(120)
        if self.engine is None:
            raise ToolFailure(f"OCR is not available: {self.error or 'still loading'}")
        with self.lock:
            out = self.engine(bgr, return_word_box=True)
        return labels_from(out, offset)


def labels_from(out, offset):
    """Split OCR lines into separate labels wherever the gap between characters is wide."""
    labels = []
    if out is None or out.boxes is None:
        return labels
    words = getattr(out, "word_results", None) or [None] * len(out.boxes)
    for box, text, score, parts in zip(out.boxes, out.txts, out.scores, words):
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        line = (min(xs), min(ys), max(xs), max(ys))
        chars = []
        for part in parts or []:
            if len(part) >= 3 and part[0]:
                part_box = part[2]
                chars.append((part[0], min(p[0] for p in part_box), max(p[0] for p in part_box)))
        if not chars:
            labels.append(make_label(text, line, score, offset))
            continue
        height = line[3] - line[1]
        group = [chars[0]]
        for item in chars[1:]:
            if item[1] - group[-1][2] > height * LABEL_GAP:
                labels.append(group_label(group, line, score, offset))
                group = [item]
            else:
                group.append(item)
        labels.append(group_label(group, line, score, offset))
    return [label for label in labels if keep_label(label)]


def group_label(group, line, score, offset):
    joined = ""
    chars = [(text, x0 + offset[0], x1 + offset[0]) for text, x0, x1 in group]
    height = line[3] - line[1]
    previous_end = None
    for text, x0, x1 in group:
        ascii_pair = text[:1].isascii() and joined[-1:].isascii() and text[:1].isalnum() and joined[-1:].isalnum()
        if ascii_pair and previous_end is not None and x0 - previous_end > height * 0.3:
            joined += " "
        joined += text
        previous_end = x1
    label = make_label(joined, (group[0][1], line[1], group[-1][2], line[3]), score, offset)
    label["chars"] = chars
    return label


def keep_label(label):
    return len(norm(label["name"])) > 1 or label["score"] >= LONE_CHAR_MIN_SCORE


def make_label(text, rect, score, offset):
    return {
        "name": text.strip(), "role": "text", "source": "ocr", "score": float(score),
        "rect": (int(rect[0] + offset[0]), int(rect[1] + offset[1]), int(rect[2] + offset[0]), int(rect[3] + offset[1])),
    }


# ---------------------------------------------------------------- UI Automation

class Automation:
    def __init__(self):
        self.uia = comtypes.client.CreateObject(UIA.CUIAutomation8, interface=UIA.IUIAutomation)
        try:
            second = self.uia.QueryInterface(UIA.IUIAutomation2)
            second.ConnectionTimeout = 1500
            second.TransactionTimeout = 1500
        except comtypes.COMError:
            pass
        request = self.uia.CreateCacheRequest()
        self.props = [
            UIA.UIA_NamePropertyId, UIA.UIA_ControlTypePropertyId, UIA.UIA_BoundingRectanglePropertyId,
            UIA.UIA_IsEnabledPropertyId, UIA.UIA_IsOffscreenPropertyId, UIA.UIA_HasKeyboardFocusPropertyId,
            UIA.UIA_IsInvokePatternAvailablePropertyId, UIA.UIA_IsTogglePatternAvailablePropertyId,
            UIA.UIA_IsSelectionItemPatternAvailablePropertyId, UIA.UIA_IsExpandCollapsePatternAvailablePropertyId,
            UIA.UIA_IsValuePatternAvailablePropertyId, UIA.UIA_ValueValuePropertyId, UIA.UIA_ToggleToggleStatePropertyId,
        ]
        for prop in self.props:
            request.AddProperty(prop)
        self.request = request
        self.true_condition = self.uia.CreateTrueCondition()

    def elements(self, hwnd):
        try:
            root = self.uia.ElementFromHandleBuildCache(hwnd, self.request)
            found = root.FindAllBuildCache(UIA.TreeScope_Descendants, self.true_condition, self.request)
        except comtypes.COMError:
            return []
        rows = []
        window = window_rect(hwnd)
        for index in range(found.Length if found else 0):
            try:
                row = self._row(found.GetElement(index), hwnd, window)
            except (comtypes.COMError, ValueError):
                continue
            if row:
                rows.append(row)
        return rows

    def _row(self, element, hwnd, window):
        role = ROLE_NAMES.get(element.CachedControlType)
        if role is None:
            return None
        rect = element.CachedBoundingRectangle
        box = (rect.left, rect.top, rect.right, rect.bottom)
        if box[2] - box[0] < 2 or box[3] - box[1] < 2 or element.CachedIsOffscreen:
            return None
        name = (element.CachedName or "").strip()
        if role in STRUCTURAL:
            # Layout panes rarely matter, unless they are small, named things like custom buttons.
            area_share = ((box[2] - box[0]) * (box[3] - box[1])) / max(1, (window[2] - window[0]) * (window[3] - window[1])) if window else 1
            if not name or area_share > 0.25:
                return None
        elif role not in ACTIONABLE and not name:
            return None
        get = element.GetCachedPropertyValue
        row = {
            "name": name, "role": role, "source": "uia", "rect": box, "element": element, "hwnd": hwnd,
            "enabled": bool(element.CachedIsEnabled), "focused": bool(get(UIA.UIA_HasKeyboardFocusPropertyId)),
            "invoke": bool(get(UIA.UIA_IsInvokePatternAvailablePropertyId)),
            "toggle": bool(get(UIA.UIA_IsTogglePatternAvailablePropertyId)),
            "select": bool(get(UIA.UIA_IsSelectionItemPatternAvailablePropertyId)),
            "expand": bool(get(UIA.UIA_IsExpandCollapsePatternAvailablePropertyId)),
            "has_value": bool(get(UIA.UIA_IsValuePatternAvailablePropertyId)),
        }
        if row["has_value"]:
            value = get(UIA.UIA_ValueValuePropertyId)
            row["value"] = value if isinstance(value, str) else ""
        if row["toggle"]:
            state = get(UIA.UIA_ToggleToggleStatePropertyId)
            row["checked"] = {0: False, 1: True}.get(state)
        return row

    def pattern(self, element, pattern_id, interface):
        unknown = element.GetCurrentPattern(pattern_id)
        if not unknown:
            return None
        return unknown.QueryInterface(interface)


# ---------------------------------------------------------------- perception

def rect_center(rect):
    return ((rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2)


def contains(rect, point):
    return rect[0] <= point[0] <= rect[2] and rect[1] <= point[1] <= rect[3]


def rect_area(rect):
    return max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])


def union(rects):
    return (min(r[0] for r in rects), min(r[1] for r in rects), max(r[2] for r in rects), max(r[3] for r in rects))


def clip_to_screen(rect):
    vx, vy, vw, vh = virtual_screen()
    return (max(rect[0], vx), max(rect[1], vy), min(rect[2], vx + vw), min(rect[3], vy + vh))


def names_agree(a, b):
    a, b = norm(a), norm(b)
    return bool(a and b) and (a == b or a in b or b in a)


def merge(uia_rows, ocr_labels):
    """One entry per thing on screen. A control keeps its reliable identity; OCR confirms or names it."""
    merged = [dict(row) for row in uia_rows]
    by_size = sorted(merged, key=lambda row: rect_area(row["rect"]))
    extras = []
    for label in ocr_labels:
        center = rect_center(label["rect"])
        holders = [row for row in by_size if contains(row["rect"], center)]
        agreeing = next((row for row in holders if names_agree(row["name"], label["name"])), None)
        if agreeing:
            agreeing["seen"] = True
            continue
        # Text on a nameless control is that control's name, e.g. a custom-drawn button.
        nameless = next((row for row in holders if not row["name"] and row["role"] in ACTIONABLE and row["role"] != "document"
                         and rect_area(row["rect"]) < rect_area(label["rect"]) * 6), None)
        if nameless:
            nameless["name"] = label["name"]
            nameless["seen"] = True
            continue
        extras.append(label)
    return merged + extras


def order(elements):
    # Elements on one visual row read left to right.
    def key(row):
        rect = row["rect"]
        return ((rect[1] + rect[3]) // 2 // 12, rect[0])
    return sorted(elements, key=key)


class Desktop:
    def __init__(self):
        self.automation = Automation()
        self.ocr = Ocr()
        self.capture = mss.mss()
        self.snapshot_number = 0
        self.elements = {}
        self.last_frame = None
        self.last_region = None
        self.last_image = None
        self.last_windows = []
        self.last_target = None
        self.ocr_cache = None

    # -- explicit short-lived browser handoff (no OCR, no general desktop access)

    def _handoff_browser(self, hwnd):
        if not hwnd or not user32.IsWindow(hwnd):
            raise ToolFailure("browser window is no longer available")
        process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED, False, window_pid(hwnd))
        if not process:
            raise ToolFailure("cannot inspect target window process")
        try:
            buf = ctypes.create_unicode_buffer(2048)
            count = wintypes.DWORD(len(buf))
            if not kernel32.QueryFullProcessImageNameW(process, 0, buf, ctypes.byref(count)):
                raise ToolFailure("cannot identify target browser")
            import os
            name = os.path.basename(buf.value).lower()
            if name not in {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe",
                            "vivaldi.exe", "opera.exe", "chromium.exe"}:
                raise ToolFailure("handoff only supports browser windows, not " + name)
        finally:
            kernel32.CloseHandle(process)
        return hwnd

    def handoff_start(self, args):
        if input_desktop_problem():
            raise ToolFailure(input_desktop_problem())
        candidates = list_windows()
        front = user32.GetForegroundWindow()
        browser = None
        for hwnd in [front] + candidates:
            try:
                self._handoff_browser(hwnd)
                browser = hwnd
                break
            except ToolFailure:
                pass
        if browser is None:
            raise ToolFailure("Open Chrome, Edge or Firefox on the PC first, then ask to take over")
        if user32.GetForegroundWindow() != browser and not activate(browser):
            raise ToolFailure("could not focus browser window")
        self.handoff_hwnd = browser
        return {"text": "browser selected", "hwnd": int(browser), "title": window_text(browser)}

    def handoff_list(self, args):
        automated = automation_pids()
        windows = []
        for hwnd in list_windows():
            try:
                self._handoff_browser(hwnd)
            except ToolFailure:
                continue
            title = window_text(hwnd)
            if not title:
                continue
            windows.append({"hwnd": int(hwnd), "title": title[:200], "automation": window_pid(hwnd) in automated,
                            "minimized": bool(user32.IsIconic(hwnd))})
        return {"text": f"{len(windows)} browser windows", "windows": windows}

    def handoff_select(self, args):
        if input_desktop_problem():
            raise ToolFailure(input_desktop_problem())
        hwnd = int(args.get("hwnd", 0))
        self._handoff_browser(hwnd)
        if user32.GetForegroundWindow() != hwnd and not activate(hwnd):
            raise ToolFailure("could not bring that browser to the front")
        self.handoff_hwnd = hwnd
        return {"text": "browser selected", "hwnd": int(hwnd), "title": window_text(hwnd)}

    def _handoff_region(self, hwnd):
        if self.handoff_hwnd != hwnd:
            raise ToolFailure("browser window was not selected for takeover")
        self._handoff_browser(hwnd)
        if user32.IsIconic(hwnd):
            raise ToolFailure("browser is minimized")
        foreground = user32.GetForegroundWindow()
        if window_pid(foreground) != window_pid(hwnd):
            raise ToolFailure("browser lost focus; bring it to the front on the PC")
        rect = window_rect(hwnd)
        if not rect:
            raise ToolFailure("browser window has no visible screen area")
        return clip_to_screen(rect)

    def handoff_frame(self, args):
        hwnd = int(args.get("hwnd", 0))
        region = self._handoff_region(hwnd)
        frame = self.grab(region)
        height, width = frame.shape[:2]
        scale = min(1.0, 1200.0 / max(width, height))
        if scale < 1:
            frame = cv2.resize(frame, (max(1, int(width * scale)), max(1, int(height * scale))), interpolation=cv2.INTER_AREA)
        ok, image = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 66])
        if not ok:
            raise ToolFailure("cannot encode browser screenshot")
        return {"text": "browser frame", "image": {"data": base64.b64encode(image.tobytes()).decode("ascii"), "mimeType": "image/jpeg"}}

    def handoff_input(self, args):
        hwnd = int(args.get("hwnd", 0))
        region = self._handoff_region(hwnd)
        action = args.get("action")
        if action not in {"click", "double_click", "right_click", "drag", "scroll", "type", "key"}:
            raise ToolFailure("unsupported input action")

        def point(prefix=""):
            import math
            x = args.get(prefix + "x")
            y = args.get(prefix + "y")
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not math.isfinite(x) or not math.isfinite(y):
                raise ToolFailure("invalid coordinates")
            if not (0 <= x <= 1 and 0 <= y <= 1):
                raise ToolFailure("coordinates outside browser")
            return (min(region[2]-1, int(region[0] + x * (region[2]-region[0]))),
                    min(region[3]-1, int(region[1] + y * (region[3]-region[1]))))

        def guard(where):
            root = root_at(*where)
            if not root or window_pid(root) != window_pid(hwnd):
                raise ToolFailure("another application is covering the browser at that position")
            if window_blocks_input(root):
                raise ToolFailure("Windows blocked input to elevated browser")

        if action in {"click", "double_click", "right_click", "scroll", "drag"}:
            start = point()
            guard(start)
            if action == "click":
                mouse_click(*start)
            elif action == "double_click":
                mouse_click(*start, count=2)
            elif action == "right_click":
                mouse_click(*start, button="right")
            elif action == "scroll":
                amount = args.get("amount")
                if not isinstance(amount, (int, float)) or not -10 <= amount <= 10:
                    raise ToolFailure("scroll amount out of range")
                mouse_wheel(*start, int(amount))
            else:
                end = point("to_")
                guard(end)
                mouse_drag(*start, *end)
        elif action == "type":
            value = args.get("text")
            if not isinstance(value, str) or len(value) > 2000:
                raise ToolFailure("text must be at most 2000 characters")
            type_text(value)
        elif action == "key":
            keys = args.get("keys")
            if keys not in {"enter", "tab", "esc", "backspace", "delete", "up", "down", "left", "right", "ctrl+a", "shift+tab", "space"}:
                raise ToolFailure("key not permitted")
            press_keys(keys)
        return {"text": action + " performed in browser"}

    # -- frames

    def grab(self, region):
        box = {"left": int(region[0]), "top": int(region[1]), "width": max(1, int(region[2] - region[0])), "height": max(1, int(region[3] - region[1]))}
        shot = np.asarray(self.capture.grab(box))
        return cv2.cvtColor(shot, cv2.COLOR_BGRA2BGR)

    def thumb(self, region):
        frame = cv2.cvtColor(self.grab(region), cv2.COLOR_BGR2GRAY)
        height, width = frame.shape
        # Half size keeps a one-character change visible while comparing fast.
        return cv2.resize(frame, (max(1, width // 2), max(1, height // 2)), interpolation=cv2.INTER_AREA)

    def wait_for_change(self, before, region, timeout_ms):
        """Returns changed and whether the screen settled, instead of sleeping a fixed time."""
        started = time.perf_counter()
        changed = False
        last = before
        last_change = started
        give_up = min(NO_CHANGE_GIVE_UP_MS, timeout_ms) / 1000
        limit = timeout_ms / 1000
        while True:
            time.sleep(0.016)
            now = time.perf_counter()
            current = self.thumb(region)
            if current.shape == last.shape:
                moving = np.count_nonzero(cv2.absdiff(current, last) > CHANGE_PIXEL_THRESHOLD) > current.size * CHANGE_RATIO
            else:
                moving = True
            if moving:
                changed = True
                last_change = now
            last = current
            if changed and now - last_change >= SETTLE_MS / 1000:
                return {"changed": True, "settled": True, "ms": int((now - started) * 1000)}
            if not changed and now - started >= give_up:
                return {"changed": False, "settled": True, "ms": int((now - started) * 1000)}
            if now - started >= limit:
                return {"changed": changed, "settled": False, "ms": int((now - started) * 1000)}

    # -- look

    def scope(self, window, whole_screen):
        problem = input_desktop_problem()
        if problem:
            raise ToolFailure(problem)
        windows = list_windows()
        if whole_screen:
            vx, vy, vw, vh = virtual_screen()
            return windows, None, [h for h in windows if window_class(h) not in NOISE_CLASSES], (vx, vy, vx + vw, vy + vh)
        target = find_window(window, windows) if window not in (None, "") else user32.GetForegroundWindow()
        if not target or window_class(target) in {"Progman", "WorkerW"}:
            vx, vy, vw, vh = virtual_screen()
            return windows, target, [], (vx, vy, vx + vw, vy + vh)
        if window not in (None, "") and user32.GetForegroundWindow() != target:
            if not activate(target):
                raise ToolFailure(f'could not bring "{window_text(target)}" to the front')
            time.sleep(0.05)
            windows = list_windows()
        related = related_windows(target, windows)
        rects = [window_rect(h) for h in related if window_rect(h)]
        return windows, target, related, clip_to_screen(union(rects))

    def wait_until_still(self, region):
        """A window just opened or just activated is often still drawing."""
        started = time.perf_counter()
        last = self.thumb(region)
        still_since = started
        while True:
            time.sleep(0.02)
            now = time.perf_counter()
            current = self.thumb(region)
            if current.shape != last.shape or np.count_nonzero(cv2.absdiff(current, last) > CHANGE_PIXEL_THRESHOLD) > current.size * CHANGE_RATIO:
                still_since = now
            last = current
            if now - still_since >= 0.06 or (now - started) * 1000 >= LOOK_SETTLE_MS:
                return

    def perceive(self, window=None, whole_screen=False, settle=False):
        windows, target, focus_set, region = self.scope(window, whole_screen)
        if settle:
            self.wait_until_still(region)
        started = time.perf_counter()
        uia_rows = []
        for hwnd in focus_set:
            uia_rows += self.automation.elements(hwnd)
        uia_ms = int((time.perf_counter() - started) * 1000)
        visible = [row for row in uia_rows if self._visible(row, focus_set)]
        frame = self.grab(region)
        started = time.perf_counter()
        key = (region, zlib.crc32(frame.tobytes()))
        if self.ocr_cache and self.ocr_cache[0] == key:
            labels = [dict(label) for label in self.ocr_cache[1]]
        else:
            labels = self.ocr.read(frame, (region[0], region[1]))
            self.ocr_cache = (key, [dict(label) for label in labels])
        ocr_ms = int((time.perf_counter() - started) * 1000)
        for label in labels:
            label["hwnd"] = root_at(*rect_center(label["rect"]))
        elements = order(merge(visible, labels))
        self.snapshot_number += 1
        numbered = {}
        for number, element in enumerate(elements[:MAX_ELEMENTS], 1):
            element["id"] = number
            hwnd = element.get("hwnd") or target
            element["hwnd"] = hwnd
            element["window_rect"] = window_rect(hwnd) if hwnd else None
            numbered[number] = element
        self.elements = numbered
        self.last_frame = frame
        self.last_region = region
        self.last_windows = windows
        self.last_target = target
        return {
            "windows": windows, "target": target, "elements": elements, "region": region, "frame": frame,
            "uia_ms": uia_ms, "ocr_ms": ocr_ms, "truncated": max(0, len(elements) - MAX_ELEMENTS),
        }

    def _visible(self, row, focus_set):
        # A control hidden behind another window can't be seen or clicked with the mouse.
        center = rect_center(row["rect"])
        root = root_at(*center)
        return root in focus_set or root == row["hwnd"]

    def render(self, seen, query=None, active_only=False):
        lines = [f"snapshot {self.snapshot_number}; coordinates are screen pixels; ids are valid until the next look or act"]
        target = seen["target"]
        for hwnd in seen["windows"]:
            title = window_text(hwnd)
            if not title or window_class(hwnd) in NOISE_CLASSES or (active_only and hwnd != target):
                continue
            rect = window_rect(hwnd)
            mark = " [active]" if hwnd == target else ""
            mini = " [minimized]" if user32.IsIconic(hwnd) else ""
            lines.append(f'window w:{hwnd} "{title[:MAX_NAME_CHARS]}" ({rect[0]},{rect[1]},{rect[2]},{rect[3]}){mark}{mini}')
        wanted = norm(query) if query else None
        shown = 0
        for element in seen["elements"][:MAX_ELEMENTS]:
            if wanted and wanted not in norm(element["name"]):
                continue
            lines.append(element_line(element))
            shown += 1
        if wanted and not shown:
            lines.append(f'nothing on screen matches "{query}"')
        if seen["truncated"]:
            lines.append(f'[{seen["truncated"]} more elements not shown; narrow with window or find]')
        lines.append(f'read: controls {seen["uia_ms"]} ms, text {seen["ocr_ms"]} ms')
        return "\n".join(lines)

    def encode_image(self, frame, region):
        height, width = frame.shape[:2]
        scale = min(1.0, IMAGE_LONG_SIDE / max(width, height))
        small = frame if scale == 1.0 else cv2.resize(frame, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
        ok, encoded = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            raise ToolFailure("could not encode the screenshot")
        self.last_image = {"region": region, "scale": scale}
        note = (f"image covers screen ({region[0]},{region[1]})-({region[2]},{region[3]}) at scale {scale:.4f}; "
                'to click a spot seen in it, call ui_act with x, y and space: "image"')
        return base64.b64encode(encoded.tobytes()).decode("ascii"), note

    def look(self, args):
        seen = self.perceive(args.get("window"), args.get("scope") == "screen", settle=True)
        text = self.render(seen, args.get("find"))
        return self.package(text, seen, args.get("image", "auto"))

    def package(self, text, seen, image_mode):
        few = sum(1 for e in seen["elements"] if e["name"]) < FEW_ELEMENTS
        reply = {"text": text}
        if image_mode is True or image_mode == "true" or (image_mode == "auto" and few):
            data, note = self.encode_image(seen["frame"], seen["region"])
            reply["text"] += "\n" + note
            reply["image"] = {"data": data, "mimeType": "image/jpeg"}
        return reply

    # -- find targets

    def by_text(self, query, role=None, nth=None, window=None):
        wanted = norm(query)
        if not wanted:
            raise ToolFailure("target has no letters or digits; use element_id or x, y")
        # What was just opened may still be drawing, so a miss gets a short second chance.
        deadline = time.perf_counter() + TARGET_RETRY_MS / 1000
        while True:
            seen = self.perceive(window, False)
            pool = seen["elements"][:MAX_ELEMENTS]
            if role:
                pool = [e for e in pool if e["role"] == role]
            matches = (
                [e for e in pool if norm(e["name"]) == wanted]
                or [e for e in pool if whole_word(e["name"], wanted)]
                or [e for e in pool if wanted in norm(e["name"])]
                or self._fuzzy(wanted, pool)
            )
            if matches:
                break
            if time.perf_counter() >= deadline:
                raise ToolFailure(f'"{query}" is not on screen; nothing was done.\n{self.render(seen)}')
            time.sleep(0.1)
        matches = [narrow_to_word(e, wanted) for e in matches]
        # A real control beats text that merely looks the same; disabled ones lose to enabled ones.
        best = min(self._rank(e) for e in matches)
        top = [e for e in matches if self._rank(e) == best]
        if nth is not None:
            if not 1 <= nth <= len(top):
                raise ToolFailure(f'nth {nth} is out of range: "{query}" has {len(top)} matches')
            return top[nth - 1]
        if len(top) > 1:
            listing = "\n".join(element_line(e) for e in top[:12])
            raise ToolFailure(f'"{query}" matches {len(top)} places; nothing was done. Choose one with element_id or nth:\n{listing}')
        return top[0]

    def _rank(self, element):
        return (0 if element.get("enabled", True) else 1, ROLE_RANK.get(element["role"], 2))

    def _fuzzy(self, wanted, pool):
        # OCR can misread one character; only long text is safe to match approximately.
        if len(wanted) < 4:
            return []
        out = []
        for element in pool:
            name = norm(element["name"])
            if abs(len(name) - len(wanted)) <= 1 and edit_distance(name, wanted) <= 1:
                out.append(element)
        return out

    def by_id(self, element_id):
        element = self.elements.get(int(element_id))
        if not element:
            raise ToolFailure(f"element {element_id} is not in the latest snapshot; look again")
        return self.confirm(element)

    def confirm(self, element):
        """An id must still mean the same thing on screen, or nothing is clicked."""
        if element["source"] == "uia":
            try:
                live = element["element"]
                name = (live.CurrentName or "").strip()
                rect = live.CurrentBoundingRectangle
                box = (rect.left, rect.top, rect.right, rect.bottom)
                role = ROLE_NAMES.get(live.CurrentControlType)
                expected = element.get("uia_name", element["name"]) if element.get("uia_name") is not None else element["name"]
                named_by_ocr = element["name"] and not name
                if role == element["role"] and (name == expected or named_by_ocr) and rect_area(box) > 0:
                    return {**element, "rect": box}
            except comtypes.COMError:
                pass
        elif self._ocr_still_there(element):
            return self._moved_with_window(element)
        return self.relocate(element)

    def _moved_with_window(self, element):
        now = window_rect(element["hwnd"]) if element.get("hwnd") else None
        then = element.get("window_rect")
        if not now or not then or now[:2] == then[:2]:
            return element
        dx, dy = now[0] - then[0], now[1] - then[1]
        rect = element["rect"]
        return {**element, "rect": (rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy)}

    def _ocr_still_there(self, element):
        moved = self._moved_with_window(element)
        rect = clip_to_screen(moved["rect"])
        if rect_area(rect) <= 0:
            return False
        pad = 8
        region = clip_to_screen((rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad))
        labels = self.ocr.read(self.grab(region), (region[0], region[1]))
        return any(names_agree(label["name"], element["name"]) for label in labels)

    def relocate(self, element):
        seen = self.perceive(element.get("hwnd") if element.get("hwnd") and user32.IsWindow(element["hwnd"]) else None)
        same = [e for e in seen["elements"] if e["role"] == element["role"] and norm(e["name"]) == norm(element["name"]) and e["name"]]
        if len(same) == 1:
            return {**same[0], "relocated": True}
        raise ToolFailure(f'element {element.get("id")} "{element["name"]}" changed or is gone; nothing was done.\n{self.render(seen)}')

    def resolve(self, args):
        if args.get("element_id") is not None:
            return self.by_id(args["element_id"])
        if args.get("target"):
            return self.by_text(args["target"], args.get("role"), args.get("nth"), args.get("window"))
        return None

    def point_from(self, args, x_key="x", y_key="y"):
        x, y = float(args[x_key]), float(args[y_key])
        if args.get("space") == "image":
            if not self.last_image:
                raise ToolFailure('no image was returned yet; call ui_look with image: true before using space: "image"')
            region, scale = self.last_image["region"], self.last_image["scale"]
            x, y = region[0] + x / scale, region[1] + y / scale
        vx, vy, vw, vh = virtual_screen()
        if not (vx <= x < vx + vw and vy <= y < vy + vh):
            raise ToolFailure(f"({int(x)},{int(y)}) is outside the screen ({vx},{vy})-({vx + vw},{vy + vh})")
        return int(x), int(y)

    # -- act

    def act(self, args):
        steps = args.get("steps")
        if steps is None:
            steps = [{k: v for k, v in args.items() if k not in ("observe", "image")}]
        if not isinstance(steps, list) or not steps:
            raise ToolFailure("steps must be a non-empty list")
        reports = []
        ok = True
        for number, step in enumerate(steps, 1):
            try:
                reports.append(self.one_step(step, number if len(steps) > 1 else None))
            except ToolFailure as failure:
                prefix = f"step {number} failed" if len(steps) > 1 else "failed"
                skipped = f"; steps {number + 1}-{len(steps)} were not run" if number < len(steps) else ""
                reports.append(f"{prefix}{skipped}: {failure}")
                ok = False
                break
        if args.get("observe", True) is False or not ok:
            return {"text": "\n".join(reports), "isError": not ok}
        seen = self.perceive()
        return self.package("\n".join(reports) + "\n" + self.render(seen, active_only=True), seen, args.get("image", "auto"))

    def one_step(self, step, number):
        action = step.get("action")
        handler = getattr(self, f"do_{action}", None) if isinstance(action, str) else None
        if handler is None:
            raise ToolFailure(f'unknown action "{action}"')
        problem = input_desktop_problem()
        if problem:
            raise ToolFailure(problem)
        region = self.watch_region(step)
        before = self.thumb(region)
        detail = handler(step)
        timeout = int(step.get("timeout_ms", DEFAULT_ACT_TIMEOUT_MS))
        if "used " in detail:
            timeout = min(timeout, INVOKE_NO_CHANGE_MS) if timeout == DEFAULT_ACT_TIMEOUT_MS else timeout
        report = self.wait_for_change(before, self.watch_region(step), timeout) if action not in ("wait",) else None
        if step.get("wait_for"):
            detail += "; " + self.wait_text(step["wait_for"], int(step.get("wait_for_ms", 10000)), step.get("window"))
        label = f"step {number}: " if number else ""
        if report is None:
            return f"{label}{detail}"
        if report["changed"]:
            state = f'screen changed in {report["ms"]} ms' + ("" if report["settled"] else ", still changing")
        else:
            state = f'no visible change within {report["ms"]} ms; the action may not have worked, or it may have no visible effect'
        return f"{label}{detail}; {state}"

    def watch_region(self, step):
        # A click can open anything anywhere, so the whole foreground area is watched.
        vx, vy, vw, vh = virtual_screen()
        return (vx, vy, vx + vw, vy + vh)

    def guard_window(self, element, point):
        """The mouse must land on what was intended, or a real click hits the wrong program."""
        hwnd = element.get("hwnd") if element else None
        if hwnd and user32.IsWindow(hwnd):
            if user32.GetForegroundWindow() != hwnd and not self._popup_of_foreground(hwnd):
                if not activate(hwnd):
                    raise ToolFailure(f'could not bring "{window_text(hwnd)}" to the front; nothing was clicked')
                time.sleep(0.05)
        root = root_at(*point)
        if hwnd and root and root != hwnd and hwnd not in owner_chain(root) and window_pid(root) != window_pid(hwnd):
            raise ToolFailure(f'"{window_text(root) or window_class(root)}" is covering that spot; nothing was clicked')
        if root and window_blocks_input(root):
            raise ToolFailure(f'"{window_text(root)}" runs as administrator and this service does not, so Windows would ignore the click; run computer-mcp setup from an administrator terminal')

    def _popup_of_foreground(self, hwnd):
        foreground = user32.GetForegroundWindow()
        return foreground and window_pid(foreground) == window_pid(hwnd)

    def click_core(self, step, count, button):
        element = self.resolve(step)
        relocated = " (it had moved; found it again)" if element and element.get("relocated") else ""
        if element is None:
            if step.get("x") is None or step.get("y") is None:
                raise ToolFailure("say what to click: element_id, target, or x and y")
            x, y = self.point_from(step)
            root = root_at(x, y)
            if root and window_blocks_input(root):
                raise ToolFailure(f'"{window_text(root)}" runs as administrator and this service does not, so Windows would ignore the click; run computer-mcp setup from an administrator terminal')
            if root and window_class(root) not in NOISE_CLASSES and user32.GetForegroundWindow() != root and not self._popup_of_foreground(root):
                activate(root)
                time.sleep(0.05)
            mouse_click(x, y, button, count)
            return f"{button} click at ({x},{y})" if count == 1 else f"double click at ({x},{y})"

        if element.get("enabled") is False:
            raise ToolFailure(f'{describe(element)} is disabled; nothing was clicked')

        method = step.get("method", "auto")
        if method not in ("auto", "invoke", "mouse"):
            raise ToolFailure("method must be auto, invoke or mouse")
        if button == "left" and count == 1 and method != "mouse" and element["source"] == "uia":
            used = self.invoke(element)
            if used:
                return f"{describe(element)}: used {used}{relocated}"
            if method == "invoke":
                raise ToolFailure(f"{describe(element)} has no direct action; try method: mouse")
        elif method == "invoke":
            raise ToolFailure(f"{describe(element)} has no direct action; try method: mouse")
        point = rect_center(clip_to_screen(element["rect"]))
        self.guard_window(element, point)
        mouse_click(point[0], point[1], button, count)
        kind = "click" if count == 1 else "double click"
        return f"{describe(element)}: {button if button != 'left' else ''}{' ' if button != 'left' else ''}{kind} at ({point[0]},{point[1]}){relocated}"

    def invoke(self, element):
        """A control's own action: exact, and it does not take the mouse. None means use the mouse."""
        live = element["element"]
        calls = []
        if element.get("invoke"):
            calls.append(("invoke", UIA.UIA_InvokePatternId, UIA.IUIAutomationInvokePattern, lambda p: p.Invoke()))
        if element.get("toggle"):
            calls.append(("toggle", UIA.UIA_TogglePatternId, UIA.IUIAutomationTogglePattern, lambda p: p.Toggle()))
        if element.get("select"):
            calls.append(("select", UIA.UIA_SelectionItemPatternId, UIA.IUIAutomationSelectionItemPattern, lambda p: p.Select()))
        if element.get("expand"):
            calls.append(("expand", UIA.UIA_ExpandCollapsePatternId, UIA.IUIAutomationExpandCollapsePattern, lambda p: p.Expand()))
        for used, pattern_id, interface, run in calls:
            try:
                pattern = self.automation.pattern(live, pattern_id, interface)
                if pattern is None:
                    continue
            except comtypes.COMError:
                continue
            outcome = {}

            def worker():
                comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
                try:
                    run(pattern)
                except comtypes.COMError as error:
                    outcome["error"] = error
                finally:
                    comtypes.CoUninitialize()

            # Invoke does not return while a button's modal dialog is open, which is success, not a hang.
            thread = threading.Thread(target=worker, daemon=True)
            thread.start()
            thread.join(INVOKE_TIMEOUT_S)
            if "error" not in outcome:
                return used
        return None

    def do_click(self, step):
        return self.click_core(step, 1, step.get("button", "left"))

    def do_double_click(self, step):
        return self.click_core(step, 2, "left")

    def do_right_click(self, step):
        return self.click_core(step, 1, "right")

    def expect_foreground(self, step):
        """Keys go wherever the focus is, so the intended window must be proven to have it."""
        hwnd = None
        if step.get("window") not in (None, ""):
            hwnd = find_window(step["window"], list_windows())
        elif self.last_windows:
            hwnd = self._last_target_window()
        if hwnd is None:
            raise ToolFailure("no window to send keys to; call ui_look first or pass window")
        foreground = user32.GetForegroundWindow()
        if foreground != hwnd and window_pid(foreground) != window_pid(hwnd):
            if step.get("window") in (None, ""):
                raise ToolFailure(f'the active window changed to "{window_text(foreground)}" since the last look; nothing was typed. Look again or pass window')
            if not activate(hwnd):
                raise ToolFailure(f'could not bring "{window_text(hwnd)}" to the front; nothing was typed')
            time.sleep(0.05)
            foreground = hwnd
        if window_blocks_input(foreground):
            raise ToolFailure(f'"{window_text(foreground)}" runs as administrator and this service does not, so Windows would ignore the keys; run computer-mcp setup from an administrator terminal')
        return foreground

    def _last_target_window(self):
        return self.last_target or user32.GetForegroundWindow()

    def do_type(self, step):
        text = step.get("text")
        if not isinstance(text, str):
            raise ToolFailure("type needs text")
        element = self.resolve(step)
        note = ""
        if element:
            self.focus_element(element)
        foreground = self.expect_foreground({**step, "window": step.get("window") or (element or {}).get("hwnd")})
        if step.get("clear") and not (element and self.clear_value(element)):
            press_keys("ctrl+a")
            time.sleep(0.02)
            press_keys("delete")
            time.sleep(0.02)
        if step.get("paste"):
            paste_text(text)
        else:
            type_text(text)
        note = self.read_back(element, text, bool(step.get("clear")))
        where = describe(element) if element else f'"{window_text(foreground)}"'
        return f"typed {len(text)} characters into {where}{note}"

    def focus_element(self, element):
        point = rect_center(clip_to_screen(element["rect"]))
        self.guard_window(element, point)
        if element["source"] == "uia":
            try:
                element["element"].SetFocus()
                return
            except comtypes.COMError:
                pass
        mouse_click(point[0], point[1])
        time.sleep(0.05)

    def clear_value(self, element):
        if not element.get("has_value") or element["source"] != "uia":
            return False
        try:
            pattern = self.automation.pattern(element["element"], UIA.UIA_ValuePatternId, UIA.IUIAutomationValuePattern)
            if pattern is None or pattern.CurrentIsReadOnly:
                return False
            pattern.SetValue("")
            return True
        except comtypes.COMError:
            return False

    def read_back(self, element, text, exact=False):
        """Compare against what the focused control now holds, where it can tell us."""
        time.sleep(0.04)
        try:
            live = element["element"] if element and element["source"] == "uia" else self.automation.uia.GetFocusedElement()
            value = self.control_text(live)
        except comtypes.COMError:
            return ""
        if value is None:
            return ""
        if norm(text) and (norm(text) == norm(value) if exact else norm(text) in norm(value)):
            return "; read back: the field holds it"
        return f'; WARNING: the field does not contain the text, it reads "{value[:MAX_NAME_CHARS]}"'

    def control_text(self, live):
        value = self.automation.pattern(live, UIA.UIA_ValuePatternId, UIA.IUIAutomationValuePattern)
        if value is not None:
            return value.CurrentValue
        document = self.automation.pattern(live, UIA.UIA_TextPatternId, UIA.IUIAutomationTextPattern)
        return document.DocumentRange.GetText(READ_BACK_CHARS) if document is not None else None

    def do_key(self, step):
        keys = step.get("keys")
        if not isinstance(keys, str):
            raise ToolFailure('key needs keys, for example "ctrl+s"')
        foreground = self.expect_foreground(step)
        press_keys(keys)
        return f'pressed {keys} in "{window_text(foreground)}"'

    def do_scroll(self, step):
        amount = float(step.get("amount", -3))
        element = self.resolve(step)
        if element:
            point = rect_center(clip_to_screen(element["rect"]))
            self.guard_window(element, point)
        elif step.get("x") is not None:
            point = self.point_from(step)
        else:
            rect = window_rect(user32.GetForegroundWindow())
            point = rect_center(rect)
        mouse_wheel(point[0], point[1], amount, bool(step.get("horizontal")))
        return f"scrolled {amount:g} at ({point[0]},{point[1]})"

    def do_drag(self, step):
        element = self.resolve(step)
        if element:
            start = rect_center(clip_to_screen(element["rect"]))
            self.guard_window(element, start)
        elif step.get("x") is not None:
            start = self.point_from(step)
        else:
            raise ToolFailure("drag needs a start: element_id, target, or x and y")
        if step.get("to_element_id") is not None:
            end = rect_center(clip_to_screen(self.by_id(step["to_element_id"])["rect"]))
        elif step.get("to_x") is not None:
            end = self.point_from(step, "to_x", "to_y")
        else:
            raise ToolFailure("drag needs an end: to_element_id, or to_x and to_y")
        mouse_drag(start[0], start[1], end[0], end[1])
        return f"dragged ({start[0]},{start[1]}) to ({end[0]},{end[1]})"

    def do_move(self, step):
        element = self.resolve(step)
        point = rect_center(clip_to_screen(element["rect"])) if element else self.point_from(step)
        mouse_move(point[0], point[1])
        return f"moved the mouse to ({point[0]},{point[1]})"

    def named_window(self, step):
        if step.get("window") in (None, ""):
            raise ToolFailure(f'{step.get("action")} needs window: a title or a w: handle')
        return find_window(step["window"], list_windows())

    def do_focus_window(self, step):
        hwnd = self.named_window(step)
        if not activate(hwnd):
            raise ToolFailure(f'could not bring "{window_text(hwnd)}" to the front')
        return f'activated "{window_text(hwnd)}"'

    def do_minimize(self, step):
        hwnd = self.named_window(step)
        user32.ShowWindow(hwnd, SW_MINIMIZE)
        return f'minimized "{window_text(hwnd)}"'

    def do_maximize(self, step):
        hwnd = self.named_window(step)
        user32.ShowWindow(hwnd, SW_MAXIMIZE)
        return f'maximized "{window_text(hwnd)}"'

    def do_restore(self, step):
        hwnd = self.named_window(step)
        user32.ShowWindow(hwnd, SW_RESTORE)
        return f'restored "{window_text(hwnd)}"'

    def do_close(self, step):
        hwnd = self.named_window(step)
        title = window_text(hwnd)
        region = window_rect(hwnd)
        before = self.thumb(clip_to_screen(region))
        user32.PostMessageW(hwnd, WM_SYSCOMMAND, SC_CLOSE, 0)
        # Alt+F4 is only for a window that truly ignored the request: sent while a
        # "save your work?" prompt is coming up, it would dismiss the prompt.
        if not self._reacted(hwnd, before, region, CLOSE_WAIT_S) and activate(hwnd):
            press_keys("alt+f4")
            self._reacted(hwnd, before, region, CLOSE_WAIT_S)
        if not user32.IsWindow(hwnd) or not user32.IsWindowVisible(hwnd):
            return f'closed "{title}"'
        return f'asked "{title}" to close; it is still open, and may be asking something such as whether to save'

    def _reacted(self, hwnd, before, region, seconds):
        deadline = time.perf_counter() + seconds
        while time.perf_counter() < deadline:
            if not user32.IsWindow(hwnd) or not user32.IsWindowVisible(hwnd) or self._changed(before, region):
                return True
            time.sleep(0.03)
        return False

    def _changed(self, before, region):
        current = self.thumb(clip_to_screen(region))
        return current.shape != before.shape or np.count_nonzero(cv2.absdiff(current, before) > CHANGE_PIXEL_THRESHOLD) > current.size * CHANGE_RATIO

    def do_wait(self, step):
        if not step.get("wait_for"):
            raise ToolFailure("wait needs wait_for: the text to wait for")
        return "waited"

    def wait_text(self, query, timeout_ms, window=None):
        wanted = norm(query)
        started = time.perf_counter()
        while True:
            try:
                seen = self.perceive(window, False)
            except ToolFailure:
                # The action may have changed the window's title, which is often the point of it.
                window = None
                seen = self.perceive(None, False)
            if any(wanted and wanted in norm(e["name"]) for e in seen["elements"]):
                return f'"{query}" appeared after {int((time.perf_counter() - started) * 1000)} ms'
            if (time.perf_counter() - started) * 1000 >= timeout_ms:
                raise ToolFailure(f'"{query}" did not appear within {timeout_ms} ms.\n{self.render(seen)}')
            time.sleep(0.05)


def describe(element):
    return f'{element["role"]} "{element["name"][:MAX_NAME_CHARS]}"'


def element_line(element):
    x, y = rect_center(element["rect"])
    name = element["name"].replace("\n", " ")
    name = name[:MAX_NAME_CHARS] + ("..." if len(name) > MAX_NAME_CHARS else "")
    flags = []
    if element.get("enabled") is False:
        flags.append("disabled")
    if element.get("focused"):
        flags.append("focused")
    if element.get("checked") is not None:
        flags.append("checked" if element["checked"] else "unchecked")
    value = element.get("value")
    if value and norm(value) != norm(element["name"]):
        flags.append(f'value="{value[:MAX_NAME_CHARS]}"')
    suffix = (" " + " ".join(flags)) if flags else ""
    return f'[{element["id"]}] {element["role"]} "{name}" ({x},{y}){suffix}'


def whole_word(name, wanted):
    return any(norm(word) == wanted for word in re.split(r"[\s/|,，、:：()（）\[\]-]+", name or ""))


def narrow_to_word(element, wanted):
    """If the wanted text is only part of an OCR label, the click belongs on that part, not the label's center."""
    chars = element.get("chars")
    if not chars or norm(element["name"]) == wanted:
        return element
    positions = []
    for text, x0, x1 in chars:
        piece = norm(text)
        width = (x1 - x0) / max(1, len(piece))
        for i, c in enumerate(piece):
            positions.append((c, x0 + i * width, x0 + (i + 1) * width))
    joined = "".join(p[0] for p in positions)
    start = joined.find(wanted)
    if start < 0:
        return element
    part = positions[start:start + len(wanted)]
    rect = element["rect"]
    return {**element, "rect": (int(part[0][1]), rect[1], int(part[-1][2]), rect[3])}


def edit_distance(a, b):
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def main():
    desktop = Desktop()
    for line in sys.stdin.buffer:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line.decode("utf-8"))
        reply = {"id": request.get("id")}
        try:
            started = time.perf_counter()
            method = request.get("method")
            args = request.get("args") or {}
            if method == "look":
                reply["result"] = desktop.look(args)
            elif method == "act":
                reply["result"] = desktop.act(args)
            elif method == "handoff_start":
                reply["result"] = desktop.handoff_start(args)
            elif method == "handoff_list":
                reply["result"] = desktop.handoff_list(args)
            elif method == "handoff_select":
                reply["result"] = desktop.handoff_select(args)
            elif method == "handoff_frame":
                reply["result"] = desktop.handoff_frame(args)
            elif method == "handoff_input":
                reply["result"] = desktop.handoff_input(args)
            elif method == "ping":
                desktop.ocr.ready.wait(120)
                reply["result"] = {"text": "ok" if desktop.ocr.engine else f"OCR failed: {desktop.ocr.error}", "elevated": SELF_ELEVATED}
            else:
                raise ToolFailure(f"unknown method {method}")
            reply["ms"] = int((time.perf_counter() - started) * 1000)
        except ToolFailure as failure:
            reply["result"] = {"text": str(failure), "isError": True}
        except Exception as error:  # noqa: BLE001
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            reply["result"] = {"text": f"desktop helper error: {type(error).__name__}: {error}", "isError": True}
        sys.stdout.buffer.write(json.dumps(reply, ensure_ascii=False).encode("utf-8") + b"\n")
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
