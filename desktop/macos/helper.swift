import Foundation
import AppKit
import ApplicationServices
import Vision
import ScreenCaptureKit
import CoreGraphics
import CryptoKit
import Darwin

private struct HelperFailure: Error {
    let message: String
}

private struct WindowRecord {
    let id: String
    let pid: pid_t
    let appName: String
    let bundleID: String
    let title: String
    let rect: CGRect
    let minimized: Bool
    let cgWindowID: CGWindowID?
    let element: AXUIElement
}

private struct WindowServerRecord {
    let id: CGWindowID
    let pid: pid_t
    let rect: CGRect
    let title: String
}

private struct ScreenRecord {
    let id: CGDirectDisplayID
    let bounds: CGRect
    let image: CGImage
}

private func axAttribute(_ element: AXUIElement, _ attribute: CFString) -> Any? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

private func axValue(_ value: Any?) -> AXValue? {
    guard let value = value else { return nil }
    let object = value as AnyObject
    guard CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
    return (object as! AXValue)
}

private func axElement(_ value: Any?) -> AXUIElement? {
    guard let value = value else { return nil }
    let object = value as AnyObject
    guard CFGetTypeID(object) == AXUIElementGetTypeID() else { return nil }
    return (object as! AXUIElement)
}

private func axString(_ element: AXUIElement, _ attribute: CFString) -> String {
    (axAttribute(element, attribute) as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

private func axRect(_ element: AXUIElement) -> CGRect? {
    guard let position = axValue(axAttribute(element, kAXPositionAttribute as CFString)),
          let size = axValue(axAttribute(element, kAXSizeAttribute as CFString)) else { return nil }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions) else { return nil }
    let rect = CGRect(origin: point, size: dimensions)
    return rect.width > 0 && rect.height > 0 ? rect : nil
}

private func normalized(_ value: String) -> String {
    value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func roleName(_ role: String) -> String {
    let roles: [String: String] = [
        "AXButton": "button", "AXCheckBox": "checkbox", "AXRadioButton": "radio",
        "AXTextField": "edit", "AXTextArea": "document", "AXTextEntryArea": "edit",
        "AXLink": "link", "AXMenuItem": "menuitem", "AXPopUpButton": "combobox",
        "AXComboBox": "combobox", "AXSlider": "slider", "AXTab": "tab",
        "AXRow": "listitem", "AXCell": "dataitem", "AXStaticText": "label",
        "AXImage": "image", "AXHeading": "header", "AXTable": "table",
        "AXList": "list", "AXOutline": "tree", "AXMenu": "menu",
        "AXToolbar": "toolbar", "AXGroup": "group", "AXWindow": "window",
        "AXSheet": "window", "AXApplication": "application", "AXWebArea": "document",
    ]
    return roles[role] ?? "custom"
}

private func jsonSafeRect(_ rect: CGRect) -> [String: Double] {
    ["left": Double(rect.minX), "top": Double(rect.minY), "right": Double(rect.maxX), "bottom": Double(rect.maxY)]
}

private func overlaps(_ a: CGRect, _ b: CGRect) -> Bool {
    !a.intersection(b).isNull && !a.intersection(b).isEmpty
}


private final class ScreenshotResult: @unchecked Sendable {
    var image: CGImage?
    var errorMessage: String?
}

private class WanjiDesktop {
    private let maxElements = 400
    private let maxDepth = 8
    private let mainDisplay = CGMainDisplayID()
    private var elementHandles: [Int: AXUIElement] = [:]
    private var rows: [[String: Any]] = []
    private var windowHandles: [String: AXUIElement] = [:]
    private var windowRecords: [WindowRecord] = []
    private var lastTargetPid: pid_t?
    private var lastTargetWindow: String?
    private var lastRegion = CGRect.zero
    private var lastImageRegion = CGRect.zero
    private var lastImageScale: CGFloat = 0
    private var lastImage: CGImage?
    private var snapshotNumber = 0
    private var lastScreenBounds = CGRect.zero
    private var selectedHandoffWindow: Int?
    private var eventAccessConfirmed = false

    private func accessibilityProblem(prompt: Bool = true) -> String? {
        if AXIsProcessTrusted() { return nil }
        if prompt {
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        }
        return "macOS has not granted Accessibility permission to Wanji Desktop Control. Open System Settings → Privacy & Security → Accessibility, enable Wanji Desktop Control, then run ui_look again."
    }

    private func activeDisplayRects() -> [CGRect] {
        if #available(macOS 15.2, *) {
            var count: UInt32 = 0
            if CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 {
                let capacity = count
                var displayCount = count
                var displays = [CGDirectDisplayID](repeating: 0, count: Int(capacity))
                let result = displays.withUnsafeMutableBufferPointer { buffer in
                    CGGetActiveDisplayList(capacity, buffer.baseAddress, &displayCount)
                }
                if result == .success && displayCount > 0 {
                    return displays.prefix(Int(displayCount)).map { CGDisplayBounds($0) }
                }
            }
        }
        // macOS 12.3–15.1 fallback: the legacy capture API can only read the main display.
        return [CGDisplayBounds(mainDisplay)]
    }

    private func activeDisplayBounds() -> CGRect {
        activeDisplayRects().reduce(CGRect.null) { $0.union($1) }
    }

    private func captureImage(in rect: CGRect) throws -> CGImage {
        if #available(macOS 15.2, *) {
            let completed = DispatchSemaphore(value: 0)
            let result = ScreenshotResult()
            SCScreenshotManager.captureImage(in: rect) { image, error in
                result.image = image
                result.errorMessage = error?.localizedDescription
                completed.signal()
            }
            guard completed.wait(timeout: .now() + 15) == .success else {
                throw HelperFailure(message: "macOS ScreenCaptureKit timed out while reading the screen")
            }
            guard let image = result.image else {
                let reason = result.errorMessage ?? "no image was returned"
                throw HelperFailure(message: "macOS ScreenCaptureKit could not capture the screen: \(reason). Check Screen Recording permission in System Settings → Privacy & Security, then restart the Wanji service.")
            }
            return image
        }

        // macOS 12.3–15.1 fallback. macOS 15.2 and later use ScreenCaptureKit above.
        guard rect.equalTo(CGDisplayBounds(mainDisplay)), let image = CGDisplayCreateImage(mainDisplay) else {
            throw HelperFailure(message: "multi-display capture requires macOS 15.2 or later")
        }
        return image
    }

    private func ensureEventAccess() throws {
        if eventAccessConfirmed { return }
        if #available(macOS 10.15, *) {
            if !CGPreflightPostEventAccess() {
                _ = CGRequestPostEventAccess()
                throw HelperFailure(message: "macOS has not granted Wanji permission to send keyboard and mouse events. Approve the macOS permission prompt for Wanji Desktop Control, then restart the Wanji service and retry ui_act.")
            }
        }
        eventAccessConfirmed = true
    }

    private func mainScreen() throws -> ScreenRecord {
        if #available(macOS 10.15, *), !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
            throw HelperFailure(message: "macOS Screen Recording permission is not enabled yet. Allow Wanji Desktop Control in System Settings → Privacy & Security → Screen & System Audio Recording, quit and restart the Wanji service, then retry ui_look.")
        }
        let bounds = activeDisplayBounds()
        guard !bounds.isNull, bounds.width > 0, bounds.height > 0 else {
            throw HelperFailure(message: "macOS did not report a usable display")
        }
        let image = try captureImage(in: bounds)
        return ScreenRecord(id: mainDisplay, bounds: bounds, image: image)
    }

    private func screenImage(_ screen: ScreenRecord, region: CGRect?) -> (CGImage, CGRect) {
        let wanted = (region ?? screen.bounds).intersection(screen.bounds)
        let scaleX = CGFloat(screen.image.width) / screen.bounds.width
        let scaleY = CGFloat(screen.image.height) / screen.bounds.height
        let crop = CGRect(
            x: (wanted.minX - screen.bounds.minX) * scaleX,
            y: (wanted.minY - screen.bounds.minY) * scaleY,
            width: wanted.width * scaleX,
            height: wanted.height * scaleY
        ).integral.intersection(CGRect(x: 0, y: 0, width: screen.image.width, height: screen.image.height))
        if let cropped = screen.image.cropping(to: crop), crop.width > 0, crop.height > 0 {
            return (cropped, wanted)
        }
        return (screen.image, screen.bounds)
    }

    private func stableWindowIdentifier(pid: pid_t, title: String, rect: CGRect, windowID: CGWindowID?) -> String {
        if let windowID { return "\(pid)-\(windowID)" }
        // Fallback for windows absent from the Window Server's metadata list.
        // Keep the title out of this key so browser navigation cannot invalidate it.
        let signature = [
            String(pid), String(Int(rect.minX.rounded())), String(Int(rect.minY.rounded())),
            String(Int(rect.width.rounded())), String(Int(rect.height.rounded())),
            normalized(title).isEmpty ? "untitled" : "titled",
        ].joined(separator: "|")
        var hash: UInt64 = 14695981039346656037
        for byte in signature.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 1099511628211
        }
        return "\(pid)-\(hash % 999_999_937)"
    }

    private func windowServerRecords() -> [WindowServerRecord] {
        guard let raw = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return [] }
        return raw.compactMap { item in
            guard let pid = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let number = (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let bounds = item[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
            return WindowServerRecord(id: number, pid: pid, rect: rect,
                                      title: item[kCGWindowName as String] as? String ?? "")
        }
    }

    private func matchWindowServerID(pid: pid_t, title: String, rect: CGRect,
                                     records: [WindowServerRecord]) -> CGWindowID? {
        let candidates = records.filter { $0.pid == pid }
        guard !rect.isEmpty else { return nil }
        let ranked = candidates.map { candidate -> (WindowServerRecord, Bool, CGFloat) in
            let other = candidate.rect
            let distance = abs(rect.minX - other.minX) + abs(rect.minY - other.minY)
                + abs(rect.width - other.width) + abs(rect.height - other.height)
            return (candidate, !title.isEmpty && candidate.title == title, distance)
        }.sorted {
            if $0.1 != $1.1 { return $0.1 }
            return $0.2 < $1.2
        }
        guard let best = ranked.first, best.2 <= 32 else { return nil }
        if ranked.count > 1, ranked[1].1 == best.1, ranked[1].2 - best.2 < 4 { return nil }
        return best.0.id
    }

    private func appWindows() -> [WindowRecord] {
        let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        var records: [WindowRecord] = []
        let serverRecords = windowServerRecords()
        let apps = NSWorkspace.shared.runningApplications
            .filter { !$0.isTerminated && $0.activationPolicy == .regular }
            .sorted { lhs, rhs in
                let leftIsFront = lhs.processIdentifier == frontPid
                let rightIsFront = rhs.processIdentifier == frontPid
                if leftIsFront != rightIsFront { return leftIsFront }
                if lhs.processIdentifier != rhs.processIdentifier { return lhs.processIdentifier < rhs.processIdentifier }
                return (lhs.localizedName ?? "") < (rhs.localizedName ?? "")
            }
        for app in apps {
            let pid = app.processIdentifier
            let axApp = AXUIElementCreateApplication(pid)
            var found = axAttribute(axApp, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
            if let focused = axElement(axAttribute(axApp, kAXFocusedWindowAttribute as CFString)) {
                if let index = found.firstIndex(where: { CFEqual($0, focused) }), index != 0 {
                    let active = found.remove(at: index)
                    found.insert(active, at: 0)
                } else if found.isEmpty {
                    found = [focused]
                }
            }
            for window in found {
                let minimized = (axAttribute(window, kAXMinimizedAttribute as CFString) as? Bool) ?? false
                let rect = axRect(window) ?? .zero
                let title = axString(window, kAXTitleAttribute as CFString)
                let appName = app.localizedName ?? "Application"
                let visibleTitle = title.isEmpty ? appName : title
                let windowID = matchWindowServerID(pid: pid, title: visibleTitle, rect: rect, records: serverRecords)
                let identifier = stableWindowIdentifier(pid: pid, title: visibleTitle, rect: rect, windowID: windowID)
                let record = WindowRecord(id: identifier, pid: pid, appName: appName,
                                          bundleID: app.bundleIdentifier ?? "", title: visibleTitle, rect: rect,
                                          minimized: minimized, cgWindowID: windowID, element: window)
                records.append(record)
            }
        }
        return records
    }

    private func chooseTarget(_ args: [String: Any], _ windows: [WindowRecord], _ screen: ScreenRecord) throws -> (WindowRecord?, CGRect, [WindowRecord]) {
        if let regionValue = args["region"] as? [String: Any] {
            guard let left = regionValue["left"] as? NSNumber, let top = regionValue["top"] as? NSNumber,
                  let right = regionValue["right"] as? NSNumber, let bottom = regionValue["bottom"] as? NSNumber,
                  right.doubleValue > left.doubleValue, bottom.doubleValue > top.doubleValue else {
                throw HelperFailure(message: "region needs valid left, top, right and bottom screen coordinates")
            }
            let rect = CGRect(x: CGFloat(left.doubleValue), y: CGFloat(top.doubleValue),
                              width: CGFloat(right.doubleValue - left.doubleValue), height: CGFloat(bottom.doubleValue - top.doubleValue))
            return (nil, rect, windows.filter { !$0.minimized && overlaps($0.rect, rect) })
        }

        if let wanted = args["window"] as? String, !wanted.isEmpty {
            let needle = normalized(wanted.replacingOccurrences(of: "^w:", with: "", options: .regularExpression))
            let matches = windows.filter {
                normalized($0.id) == needle || normalized($0.title).contains(needle) || normalized($0.appName).contains(needle)
            }
            guard !matches.isEmpty else {
                throw HelperFailure(message: "no open macOS window matches \"\(wanted)\"")
            }
            let exact = matches.first { normalized($0.id) == needle || normalized($0.title) == needle }
            guard let selected = exact ?? (matches.count == 1 ? matches[0] : nil) else {
                let options = matches.prefix(12).map { "w:\($0.id) \"\($0.title.prefix(80))\"" }.joined(separator: "\n")
                throw HelperFailure(message: "\"\(wanted)\" matches several windows; use one of these handles:\n\(options)")
            }
            if selected.minimized {
                try activate(selected)
                let refreshed = appWindows().first(where: {
                    $0.pid == selected.pid && $0.title == selected.title && isFocusedWindow($0)
                }) ?? selected
                return (refreshed, refreshed.rect.intersection(screen.bounds), [refreshed])
            }
            return (selected, selected.rect.intersection(screen.bounds), [selected])
        }

        let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let active = windows.first { $0.pid == frontPid && !$0.minimized && !$0.rect.isEmpty }
        if args["scope"] as? String == "screen" {
            return (active, screen.bounds, windows.filter { !$0.minimized && overlaps($0.rect, screen.bounds) })
        }
        if let active {
            return (active, active.rect.intersection(screen.bounds), [active])
        }
        return (nil, screen.bounds, windows.filter { !$0.minimized && overlaps($0.rect, screen.bounds) })
    }

    private func activate(_ window: WindowRecord) throws {
        guard let app = NSRunningApplication(processIdentifier: window.pid) else {
            throw HelperFailure(message: "the target application is no longer running")
        }
        if window.minimized {
            let restored = AXUIElementSetAttributeValue(window.element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            if restored != .success { throw HelperFailure(message: "macOS could not restore the target window") }
        }
        _ = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        _ = AXUIElementPerformAction(window.element, kAXRaiseAction as CFString)
        lastTargetPid = window.pid
        lastTargetWindow = window.id
        Thread.sleep(forTimeInterval: 0.08)
    }

    private func collectControls(_ window: WindowRecord, region: CGRect) -> [[String: Any]] {
        var result: [[String: Any]] = []
        var visited = Set<String>()
        func visit(_ element: AXUIElement, depth: Int) {
            if depth > maxDepth || result.count >= maxElements { return }
            let identifier = String(describing: CFHash(element))
            if visited.contains(identifier) { return }
            visited.insert(identifier)
            let role = axString(element, kAXRoleAttribute as CFString)
            let kind = roleName(role)
            let title = axString(element, kAXTitleAttribute as CFString)
            let description = axString(element, kAXDescriptionAttribute as CFString)
            let value = axAttribute(element, kAXValueAttribute as CFString).map { String(describing: $0) } ?? ""
            let name = !title.isEmpty ? title : (!description.isEmpty ? description : value)
            if let rect = axRect(element), overlaps(rect, region) {
                let enabled = axAttribute(element, kAXEnabledAttribute as CFString) as? Bool
                let focused = (axAttribute(element, kAXFocusedAttribute as CFString) as? Bool) ?? false
                let actionable = ["button", "checkbox", "radio", "edit", "document", "link", "menuitem", "combobox", "slider", "tab", "listitem", "dataitem"].contains(kind)
                if actionable || (!name.isEmpty && !["group", "custom", "application"].contains(kind)) {
                    result.append([
                        "name": String(name.prefix(200)), "role": kind,
                        "rect": jsonSafeRect(rect), "enabled": enabled ?? true,
                        "focused": focused, "value": String(value.prefix(200)),
                        "source": "accessibility", "window": window.id,
                        "_handle": element,
                    ])
                }
            }
            if let children = axAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] {
                for child in children {
                    visit(child, depth: depth + 1)
                    if result.count >= maxElements { break }
                }
            }
        }
        visit(window.element, depth: 0)
        return result
    }

    private func ocrLabels(_ image: CGImage, region: CGRect) -> [[String: Any]] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
        } catch {
            return []
        }
        let scaleX = CGFloat(image.width) / max(1, region.width)
        let scaleY = CGFloat(image.height) / max(1, region.height)
        return (request.results ?? []).compactMap { observation in
            guard let text = observation.topCandidates(1).first?.string, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            let box = observation.boundingBox
            let rect = CGRect(x: region.minX + box.minX * region.width,
                              y: region.minY + (1 - box.maxY) * region.height,
                              width: box.width * region.width, height: box.height * region.height)
            guard rect.width > 1 / max(scaleX, 1), rect.height > 1 / max(scaleY, 1) else { return nil }
            return ["name": String(text.prefix(200)), "role": "text", "rect": jsonSafeRect(rect),
                    "enabled": true, "focused": false, "value": "", "source": "ocr", "window": ""]
        }
    }

    private func rectFromRow(_ row: [String: Any]) -> CGRect {
        guard let rect = row["rect"] as? [String: Double],
              let l = rect["left"], let t = rect["top"], let r = rect["right"], let b = rect["bottom"] else { return .zero }
        return CGRect(x: l, y: t, width: r - l, height: b - t)
    }

    private func combine(_ controls: [[String: Any]], _ labels: [[String: Any]]) -> [[String: Any]] {
        var result = controls
        for label in labels {
            let name = normalized(label["name"] as? String ?? "")
            let rect = rectFromRow(label)
            let duplicate = controls.contains { row in
                normalized(row["name"] as? String ?? "") == name && overlaps(rectFromRow(row).insetBy(dx: -8, dy: -4), rect)
            }
            if !duplicate { result.append(label) }
        }
        return result.sorted { lhs, rhs in
            let a = rectFromRow(lhs), b = rectFromRow(rhs)
            if abs(a.minY - b.minY) > 6 { return a.minY < b.minY }
            return a.minX < b.minX
        }
    }

    private func elementLine(_ row: [String: Any]) -> String {
        let rect = rectFromRow(row)
        let name = (row["name"] as? String ?? "").replacingOccurrences(of: "\n", with: " ")
        var flags: [String] = []
        if (row["enabled"] as? Bool) == false { flags.append("disabled") }
        if (row["focused"] as? Bool) == true { flags.append("focused") }
        let value = row["value"] as? String ?? ""
        if !value.isEmpty && normalized(value) != normalized(name) { flags.append("value=\"\(value.prefix(80))\"") }
        let suffix = flags.isEmpty ? "" : " " + flags.joined(separator: " ")
        let id = row["id"] as? Int ?? 0
        let role = row["role"] as? String ?? "text"
        return "[\(id)] \(role) \"\(name.prefix(80))\" (\(Int(rect.midX)),\(Int(rect.midY)))\(suffix)"
    }

    private func render(_ windows: [WindowRecord], target: WindowRecord?, query: String?) -> String {
        var lines = ["snapshot \(snapshotNumber); coordinates are screen points; ids are valid until the next look or act"]
        for window in windows {
            let mark = window.id == target?.id ? " [active]" : ""
            let mini = window.minimized ? " [minimized]" : ""
            lines.append("window w:\(window.id) \"\(window.title.prefix(80))\" (\(Int(window.rect.minX)),\(Int(window.rect.minY)),\(Int(window.rect.maxX)),\(Int(window.rect.maxY)))\(mark)\(mini)")
        }
        let wanted = query.map(normalized)
        var shown = 0
        for row in rows {
            let name = row["name"] as? String ?? ""
            if let wanted, !wanted.isEmpty, !normalized(name).contains(wanted) { continue }
            lines.append(elementLine(row))
            shown += 1
        }
        if let wanted, !wanted.isEmpty, shown == 0 { lines.append("nothing on screen matches \"\(query ?? "")\"") }
        lines.append("read: controls accessibility, text Vision OCR")
        return lines.joined(separator: "\n")
    }

    private func jpegData(_ image: CGImage, maxLongSide: CGFloat = 1568) -> (Data, CGFloat)? {
        let sourceSize = CGSize(width: image.width, height: image.height)
        let scale = min(1, maxLongSide / max(sourceSize.width, sourceSize.height))
        let width = max(1, Int((sourceSize.width * scale).rounded()))
        let height = max(1, Int((sourceSize.height * scale).rounded()))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let small = context.makeImage() else { return nil }
        let rep = NSBitmapImageRep(cgImage: small)
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.78]) else { return nil }
        return (data, scale)
    }

    private func package(_ text: String, _ image: CGImage, _ region: CGRect, _ imageMode: Any?) -> [String: Any] {
        lastImageRegion = .zero
        lastImageScale = 0
        var reply: [String: Any] = ["text": text]
        let named = rows.filter { !(($0["name"] as? String ?? "").isEmpty) }.count
        let mode = imageMode as? String ?? "auto"
        if mode == "true" || (mode == "auto" && named < 3) {
            if let (data, scale) = jpegData(image) {
                let pixelPerPoint = CGFloat(image.width) / max(1, region.width)
                lastImageRegion = region
                lastImageScale = pixelPerPoint * scale
                reply["text"] = text + "\nimage covers screen (\(Int(region.minX)),\(Int(region.minY)))-(\(Int(region.maxX)),\(Int(region.maxY))) at scale \(String(format: "%.4f", Double(lastImageScale))); to click a spot seen in it, call ui_act with x, y and space: \"image\""
                reply["image"] = ["data": data.base64EncodedString(), "mimeType": "image/jpeg"]
            } else {
                reply["text"] = text + "\nCould not encode the desktop screenshot."
            }
        }
        return reply
    }

    private func buildLook(_ args: [String: Any]) throws -> (String, CGImage, CGRect, WindowRecord?) {
        if let problem = accessibilityProblem() { throw HelperFailure(message: problem) }
        let screen = try mainScreen()
        let allWindows = appWindows()
        let (target, wantedRegion, selectedWindows) = try chooseTarget(args, allWindows, screen)
        let region = wantedRegion.isEmpty ? screen.bounds : wantedRegion.intersection(screen.bounds)
        guard !region.isEmpty else { throw HelperFailure(message: "the selected window is not on the main display") }
        if let target { lastTargetPid = target.pid; lastTargetWindow = target.id }
        if let target, args["window"] != nil { try activate(target) }

        let (frame, actualRegion) = screenImage(screen, region: region)
        var controls: [[String: Any]] = []
        for window in selectedWindows where !window.minimized && overlaps(window.rect, actualRegion) {
            controls.append(contentsOf: collectControls(window, region: actualRegion))
            if controls.count >= maxElements { break }
        }
        let labels = ocrLabels(frame, region: actualRegion).map { label -> [String: Any] in
            var copy = label
            let rect = rectFromRow(label)
            copy["window"] = selectedWindows.first(where: { overlaps($0.rect, rect) })?.id ?? target?.id ?? ""
            return copy
        }
        rows = combine(controls, labels).prefix(maxElements).map { $0 }
        elementHandles.removeAll(keepingCapacity: true)
        windowHandles.removeAll(keepingCapacity: true)
        for window in selectedWindows { windowHandles[window.id] = window.element }
        for (index, row) in rows.enumerated() {
            var copy = row
            copy["id"] = index + 1
            rows[index] = copy
            if let handle = axElement(row["_handle"]) { elementHandles[index + 1] = handle }
        }
        windowRecords = appWindows()
        snapshotNumber += 1
        lastRegion = actualRegion
        lastImage = frame
        lastScreenBounds = screen.bounds
        let visibleWindows = selectedWindows.filter { !$0.rect.isEmpty && overlaps($0.rect, actualRegion) }
        let query = args["find"] as? String
        let text = render(visibleWindows, target: target, query: query)
        return (text, frame, actualRegion, target)
    }

    func look(_ args: [String: Any]) throws -> [String: Any] {
        let (text, frame, region, _) = try buildLook(args)
        return package(text, frame, region, args["image"])
    }

    private func screenPoint(_ args: [String: Any], prefix: String = "") throws -> CGPoint {
        let xKey = prefix.isEmpty ? "x" : prefix + "x"
        let yKey = prefix.isEmpty ? "y" : prefix + "y"
        guard let x = args[xKey] as? NSNumber, let y = args[yKey] as? NSNumber,
              x.doubleValue.isFinite, y.doubleValue.isFinite else {
            throw HelperFailure(message: "this action needs numeric \(xKey) and \(yKey) coordinates")
        }
        if lastScreenBounds.isEmpty { lastScreenBounds = CGDisplayBounds(mainDisplay) }
        var point = CGPoint(x: CGFloat(x.doubleValue), y: CGFloat(y.doubleValue))
        if args["space"] as? String == "image" {
            guard lastImageScale > 0, !lastImageRegion.isEmpty else {
                throw HelperFailure(message: "no screenshot image was returned yet; call ui_look with image: true before using space: image")
            }
            point = CGPoint(x: lastImageRegion.minX + point.x / lastImageScale,
                            y: lastImageRegion.minY + point.y / lastImageScale)
        }
        guard lastScreenBounds.contains(point), activeDisplayRects().contains(where: { $0.contains(point) }) else {
            throw HelperFailure(message: "(\(Int(point.x)),\(Int(point.y))) is not on an active display")
        }
        return point
    }

    private func refreshRow(_ old: [String: Any]) throws -> [String: Any] {
        let name = normalized(old["name"] as? String ?? "")
        let role = old["role"] as? String ?? ""
        let window = old["window"] as? String ?? ""
        guard !name.isEmpty else {
            throw HelperFailure(message: "this element has no readable label and cannot be safely re-identified; use fresh screen coordinates instead")
        }
        _ = try buildLook(["window": window.isEmpty ? "" : "w:\(window)", "image": "false"])
        let matches = rows.filter {
            normalized($0["name"] as? String ?? "") == name
                && ($0["role"] as? String ?? "") == role
                && ((($0["window"] as? String) ?? "") == window || window.isEmpty)
        }
        guard !matches.isEmpty else {
            throw HelperFailure(message: "\(old["role"] ?? "element") \"\(old["name"] ?? "")\" changed or disappeared; nothing was done. Look again")
        }
        let oldPoint = rectFromRow(old).midpoint
        let ranked = matches.sorted {
            hypot(rectFromRow($0).midpoint.x - oldPoint.x, rectFromRow($0).midpoint.y - oldPoint.y)
                < hypot(rectFromRow($1).midpoint.x - oldPoint.x, rectFromRow($1).midpoint.y - oldPoint.y)
        }
        if ranked.count > 1 {
            let first = hypot(rectFromRow(ranked[0]).midpoint.x - oldPoint.x, rectFromRow(ranked[0]).midpoint.y - oldPoint.y)
            let second = hypot(rectFromRow(ranked[1]).midpoint.x - oldPoint.x, rectFromRow(ranked[1]).midpoint.y - oldPoint.y)
            if abs(second - first) < 8 {
                throw HelperFailure(message: "this element no longer identifies one unique control; look again")
            }
        }
        return ranked[0]
    }

    private func rowForTarget(_ step: [String: Any]) throws -> [String: Any]? {
        if let id = step["element_id"] as? Int {
            guard let old = rows.first(where: { ($0["id"] as? Int) == id }) else {
                throw HelperFailure(message: "element \(id) is not in the latest snapshot; look again")
            }
            return try refreshRow(old)
        }
        if let target = step["target"] as? String, !target.isEmpty {
            _ = try buildLook(["window": step["window"] ?? "", "image": "false"])
            let wanted = normalized(target)
            var matches = rows.filter { normalized($0["name"] as? String ?? "").contains(wanted) }
            if let role = step["role"] as? String { matches = matches.filter { ($0["role"] as? String) == role } }
            guard !matches.isEmpty else { throw HelperFailure(message: "\"\(target)\" is not on screen; nothing was done") }
            if let nth = step["nth"] as? Int {
                guard nth >= 1 && nth <= matches.count else { throw HelperFailure(message: "nth \(nth) is out of range") }
                return matches[nth - 1]
            }
            guard matches.count == 1 else {
                let listing = matches.prefix(10).map(elementLine).joined(separator: "\n")
                throw HelperFailure(message: "\"\(target)\" matches \(matches.count) places; choose element_id or nth:\n\(listing)")
            }
            return matches[0]
        }
        return nil
    }

    private func postMouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton = .left) throws {
        try ensureEventAccess()
        guard let event = CGEvent(mouseEventSource: CGEventSource(stateID: .combinedSessionState), mouseType: type,
                                 mouseCursorPosition: point, mouseButton: button) else {
            throw HelperFailure(message: "macOS could not create the mouse event")
        }
        event.post(tap: .cghidEventTap)
    }

    private func click(_ point: CGPoint, button: CGMouseButton = .left, count: Int = 1) throws {
        let down: CGEventType = button == .right ? .rightMouseDown : (button == .center ? .otherMouseDown : .leftMouseDown)
        let up: CGEventType = button == .right ? .rightMouseUp : (button == .center ? .otherMouseUp : .leftMouseUp)
        for index in 1...max(1, min(count, 2)) {
            try postMouse(down, at: point, button: button)
            try postMouse(up, at: point, button: button)
            Thread.sleep(forTimeInterval: index == count ? 0 : 0.07)
        }
    }

    private func ensureForeground(_ step: [String: Any], _ row: [String: Any]? = nil) throws {
        if let windowName = step["window"] as? String, !windowName.isEmpty {
            windowRecords = appWindows()
            let needle = normalized(windowName.replacingOccurrences(of: "^w:", with: "", options: .regularExpression))
            guard let window = windowRecords.first(where: { normalized($0.id) == needle || normalized($0.title).contains(needle) || normalized($0.appName).contains(needle) }) else {
                throw HelperFailure(message: "no open macOS window matches \"\(windowName)\"")
            }
            try activate(window)
            return
        }
        let pid = (row?["window"] as? String).flatMap { value in
            Int32(value.split(separator: "-").first ?? "")
        } ?? lastTargetPid
        guard let pid else { throw HelperFailure(message: "no target window; call ui_look first or pass window") }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            throw HelperFailure(message: "the active macOS window changed since the last look; nothing was typed. Look again or pass window")
        }
    }

    private func keyCode(_ name: String) -> CGKeyCode? {
        let codes: [String: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
            "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
            "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
            "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
            "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
            "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
            "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51,
            "esc": 53, "escape": 53, "command": 55, "cmd": 55, "shift": 56, "capslock": 57,
            "option": 58, "alt": 58, "control": 59, "ctrl": 59, "right": 124, "left": 123,
            "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
            "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        ]
        return codes[name.lowercased()]
    }

    private func pressKeys(_ combo: String) throws {
        try ensureEventAccess()
        let normalizedCombo = combo.lowercased() == "ctrl+a" ? "cmd+a" : combo
        let parts = normalizedCombo.lowercased().split(separator: "+").map(String.init)
        guard let key = parts.last, let code = keyCode(key) else { throw HelperFailure(message: "unsupported key combination \"\(combo)\"") }
        var flags: CGEventFlags = []
        for modifier in parts.dropLast() {
            switch modifier {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "ctrl", "control": flags.insert(.maskControl)
            case "alt", "option": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            default: throw HelperFailure(message: "unsupported modifier \"\(modifier)\"")
            }
        }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
            throw HelperFailure(message: "macOS could not create the keyboard event")
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    private func pasteText(_ text: String) throws {
        let pasteboard = NSPasteboard.general
        let previous = pasteboard.string(forType: .string)
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            throw HelperFailure(message: "macOS could not place the requested text on the clipboard")
        }
        defer {
            pasteboard.clearContents()
            if let previous { _ = pasteboard.setString(previous, forType: .string) }
        }
        try pressKeys("cmd+v")
        Thread.sleep(forTimeInterval: 0.15)
    }

    private func typeText(_ text: String) throws {
        try ensureEventAccess()
        guard let source = CGEventSource(stateID: .combinedSessionState) else { throw HelperFailure(message: "macOS could not create a keyboard event source") }
        let normalizedText = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalizedText.split(separator: "\n", omittingEmptySubsequences: false)
        for (lineIndex, line) in lines.enumerated() {
            let units = Array(line.utf16)
            var offset = 0
            while offset < units.count {
                var count = min(20, units.count - offset)
                if offset + count < units.count {
                    let last = units[offset + count - 1]
                    let next = units[offset + count]
                    if (0xD800...0xDBFF).contains(last) && (0xDC00...0xDFFF).contains(next) { count -= 1 }
                }
                let chunk = Array(units[offset..<(offset + count)])
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                    throw HelperFailure(message: "macOS could not create a text event")
                }
                chunk.withUnsafeBufferPointer { buffer in
                    down.keyboardSetUnicodeString(stringLength: count, unicodeString: buffer.baseAddress)
                    up.keyboardSetUnicodeString(stringLength: count, unicodeString: buffer.baseAddress)
                }
                down.post(tap: .cghidEventTap)
                up.post(tap: .cghidEventTap)
                offset += count
            }
            if lineIndex < lines.count - 1 { try pressKeys("enter") }
        }
    }

    private func rowPoint(_ row: [String: Any]) -> CGPoint {
        rectFromRow(row).offsetBy(dx: 0, dy: 0).midpoint
    }

    private func perform(_ step: [String: Any]) throws -> String {
        guard let action = step["action"] as? String else { throw HelperFailure(message: "action is required") }
        let dragDestinationSnapshot: [String: Any]?
        if action == "drag", let destinationID = step["to_element_id"] as? Int {
            guard let destination = rows.first(where: { ($0["id"] as? Int) == destinationID }) else {
                throw HelperFailure(message: "destination element \(destinationID) is not in the latest snapshot; look again")
            }
            dragDestinationSnapshot = destination
        } else {
            dragDestinationSnapshot = nil
        }
        let row = try rowForTarget(step)
        if let row, (row["enabled"] as? Bool) == false {
            throw HelperFailure(message: "\(row["role"] ?? "control") \"\(row["name"] ?? "")\" is disabled; nothing was done")
        }
        switch action {
        case "click", "double_click", "right_click":
            let point = try row.map(rowPoint) ?? screenPoint(step)
            let method = step["method"] as? String ?? "auto"
            guard ["auto", "invoke", "mouse"].contains(method) else { throw HelperFailure(message: "method must be auto, invoke or mouse") }
            if method == "invoke", row == nil { throw HelperFailure(message: "method invoke requires element_id or target") }
            if method == "invoke", let row, let id = row["id"] as? Int, elementHandles[id] == nil {
                throw HelperFailure(message: "this OCR-only target has no direct accessibility action; try method: mouse")
            }
            if let row, method != "mouse", let id = row["id"] as? Int, let handle = elementHandles[id], action == "click" {
                let press = AXUIElementPerformAction(handle, kAXPressAction as CFString)
                if press == .success { return "\(row["role"] ?? "control") \"\(row["name"] ?? "")\": used press action" }
                if method == "invoke" { throw HelperFailure(message: "this control has no direct press action; try method: mouse") }
            }
            let button: CGMouseButton = action == "right_click" ? .right : .left
            try click(point, button: button, count: action == "double_click" ? 2 : 1)
            return "\(action.replacingOccurrences(of: "_", with: " ")) at (\(Int(point.x)),\(Int(point.y)))"

        case "type":
            guard let value = step["text"] as? String else { throw HelperFailure(message: "type needs text") }
            guard value.count <= 20000 else { throw HelperFailure(message: "text must be at most 20000 characters") }
            try ensureForeground(step, row)
            if let row {
                let focused: Bool
                if let id = row["id"] as? Int, let handle = elementHandles[id] {
                    focused = AXUIElementSetAttributeValue(handle, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
                } else {
                    focused = false
                }
                if !focused {
                    try click(rowPoint(row))
                    Thread.sleep(forTimeInterval: 0.05)
                }
            }
            if step["clear"] as? Bool == true {
                try pressKeys("cmd+a")
                try pressKeys("backspace")
            }
            if step["paste"] as? Bool == true {
                try pasteText(value)
            } else {
                try typeText(value)
            }
            var readBack = ""
            if let row, let id = row["id"] as? Int, let handle = elementHandles[id] {
                let actual = axString(handle, kAXValueAttribute as CFString)
                if !actual.isEmpty {
                    let expected = normalized(value)
                    let observed = normalized(actual)
                    if !expected.isEmpty && (step["clear"] as? Bool == true ? expected == observed : observed.contains(expected)) {
                        readBack = "; read back: the field holds it"
                    } else if !expected.isEmpty {
                        readBack = "; WARNING: the field does not contain the text"
                    }
                }
            }
            return "typed \(value.count) characters\(readBack)"

        case "key":
            guard let keys = step["keys"] as? String else { throw HelperFailure(message: "key needs keys, for example cmd+s or enter") }
            try ensureForeground(step, row)
            try pressKeys(keys)
            return "pressed \(keys)"

        case "scroll":
            try ensureEventAccess()
            let amount = (step["amount"] as? NSNumber)?.doubleValue ?? -3
            guard amount.isFinite, abs(amount) <= 10 else { throw HelperFailure(message: "scroll amount must be between -10 and 10") }
            let point = try row.map(rowPoint) ?? (step["x"] == nil ? CGPoint(x: lastRegion.midX, y: lastRegion.midY) : screenPoint(step))
            guard let event = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .combinedSessionState), units: .line,
                                      wheelCount: 2, wheel1: Int32(amount), wheel2: (step["horizontal"] as? Bool == true) ? Int32(amount) : 0, wheel3: 0) else {
                throw HelperFailure(message: "macOS could not create the scroll event")
            }
            event.location = point
            event.post(tap: .cghidEventTap)
            return "scrolled \(amount) at (\(Int(point.x)),\(Int(point.y)))"

        case "drag":
            let start = try row.map(rowPoint) ?? screenPoint(step)
            let end: CGPoint
            if let oldDestination = dragDestinationSnapshot {
                let destinationRow = try refreshRow(oldDestination)
                if (destinationRow["enabled"] as? Bool) == false {
                    throw HelperFailure(message: "drag destination \"\(destinationRow["name"] ?? "")\" is disabled")
                }
                end = rowPoint(destinationRow)
            } else {
                end = try screenPoint(step, prefix: "to_")
            }
            try postMouse(.leftMouseDown, at: start)
            let distance = hypot(end.x - start.x, end.y - start.y)
            let count = max(3, min(24, Int(distance / 28)))
            for index in 1...count {
                let t = CGFloat(index) / CGFloat(count)
                let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
                try postMouse(.leftMouseDragged, at: point)
                Thread.sleep(forTimeInterval: 0.01)
            }
            try postMouse(.leftMouseUp, at: end)
            return "dragged (\(Int(start.x)),\(Int(start.y))) to (\(Int(end.x)),\(Int(end.y)))"

        case "move":
            let point = try row.map(rowPoint) ?? screenPoint(step)
            try postMouse(.mouseMoved, at: point)
            return "moved the mouse to (\(Int(point.x)),\(Int(point.y)))"

        case "focus_window", "minimize", "maximize", "restore", "close":
            guard let name = step["window"] as? String, !name.isEmpty else { throw HelperFailure(message: "\(action) needs window: a title or w: handle") }
            windowRecords = appWindows()
            let needle = normalized(name.replacingOccurrences(of: "^w:", with: "", options: .regularExpression))
            guard let window = windowRecords.first(where: { normalized($0.id) == needle || normalized($0.title).contains(needle) || normalized($0.appName).contains(needle) }) else {
                throw HelperFailure(message: "no open macOS window matches \"\(name)\"; call ui_look first")
            }
            switch action {
            case "focus_window": try activate(window); return "activated \"\(window.title)\""
            case "minimize":
                let result = AXUIElementSetAttributeValue(window.element, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
                if result != .success { throw HelperFailure(message: "macOS could not minimize \"\(window.title)\"") }
                return "minimized \"\(window.title)\""
            case "restore":
                let result = AXUIElementSetAttributeValue(window.element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                if result != .success { throw HelperFailure(message: "macOS could not restore \"\(window.title)\"") }
                try activate(window)
                return "restored \"\(window.title)\""
            case "maximize":
                let display = activeDisplayRects().max { lhs, rhs in
                    let a = lhs.intersection(window.rect), b = rhs.intersection(window.rect)
                    return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
                }
                if let display, window.rect.width >= display.width * 0.93 && window.rect.height >= display.height * 0.88 {
                    return "\"\(window.title)\" already fills its display"
                }
                if let zoom = axElement(axAttribute(window.element, kAXZoomButtonAttribute as CFString)),
                   AXUIElementPerformAction(zoom, kAXPressAction as CFString) == .success { return "maximized \"\(window.title)\"" }
                throw HelperFailure(message: "this application does not expose a maximize control")
            default:
                if let close = axElement(axAttribute(window.element, kAXCloseButtonAttribute as CFString)),
                   AXUIElementPerformAction(close, kAXPressAction as CFString) == .success { return "asked \"\(window.title)\" to close" }
                throw HelperFailure(message: "this application does not expose a close control")
            }

        case "wait": return "waited"
        default: throw HelperFailure(message: "unknown action \"\(action)\"")
        }
    }

    private func imageDigest() -> String {
        guard let screen = try? mainScreen() else { return "" }
        let data = screen.image.dataProvider?.data as Data? ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func act(_ args: [String: Any]) throws -> [String: Any] {
        if let problem = accessibilityProblem() { throw HelperFailure(message: problem) }
        let steps: [[String: Any]]
        if let list = args["steps"] as? [[String: Any]] { steps = list }
        else { steps = [args.filter { $0.key != "observe" && $0.key != "image" }] }
        guard !steps.isEmpty else { throw HelperFailure(message: "steps must be a non-empty list") }
        var reports: [String] = []
        var failed = false
        for (index, step) in steps.enumerated() {
            let before = imageDigest()
            do {
                if (step["action"] as? String) == "wait", (step["wait_for"] as? String ?? "").isEmpty {
                    throw HelperFailure(message: "wait needs wait_for: the text to wait for")
                }
                let detail = try perform(step)
                let action = step["action"] as? String ?? ""
                if let waitFor = step["wait_for"] as? String, !waitFor.isEmpty {
                    let timeout = min(30000, max(100, (step["wait_for_ms"] as? NSNumber)?.intValue ?? 10000))
                    let deadline = Date().addingTimeInterval(Double(timeout) / 1000)
                    var found = false
                    while Date() < deadline {
                        let seen = try buildLook(["image": "false"])
                        if rows.contains(where: { normalized($0["name"] as? String ?? "").contains(normalized(waitFor)) }) { found = true; break }
                        Thread.sleep(forTimeInterval: 0.15)
                    }
                    if !found { throw HelperFailure(message: "\"\(waitFor)\" did not appear within \(timeout) ms") }
                }
                let timeout = min(5000, max(0, (step["timeout_ms"] as? NSNumber)?.intValue ?? 1500))
                if action != "wait" && timeout > 0 { Thread.sleep(forTimeInterval: Double(timeout) / 1000) }
                let after = imageDigest()
                let changed = !before.isEmpty && !after.isEmpty && before != after
                let state = changed ? "screen changed" : "no visible change; the action may not have worked, or it may have no visible effect"
                reports.append("\(steps.count > 1 ? "step \(index + 1): " : "")\(detail); \(state)")
            } catch let failure as HelperFailure {
                reports.append("\(steps.count > 1 ? "step \(index + 1) failed; steps \(index + 2)-\(steps.count) were not run: " : "failed: ")\(failure.message)")
                failed = true
                break
            }
        }
        let text = reports.joined(separator: "\n")
        if args["observe"] as? Bool == false || failed { return ["text": text, "isError": failed] }
        let lookArgs: [String: Any] = ["image": args["image"] ?? "auto"]
        let (freshText, frame, region, _) = try buildLook(lookArgs)
        return package(text + "\n" + freshText, frame, region, args["image"])
    }

    private func handoffNumber(_ window: WindowRecord) -> Int {
        if let windowID = window.cgWindowID { return Int(windowID) }
        let suffix = Int(window.id.split(separator: "-").last ?? "0") ?? 0
        return Int(window.pid) * 1_000_000_000 + suffix
    }

    private func isBrowser(_ window: WindowRecord) -> Bool {
        let allowed: Set<String> = [
            "com.google.Chrome", "com.microsoft.edgemac", "org.mozilla.firefox",
            "com.brave.Browser", "com.apple.Safari", "com.vivaldi.Vivaldi",
            "com.operasoftware.Opera", "org.chromium.Chromium", "company.thebrowser.Arc", "company.thebrowser.Browser",
        ]
        return allowed.contains(window.bundleID)
    }

    private func handoffStart() throws -> [String: Any] {
        if let problem = accessibilityProblem() { throw HelperFailure(message: problem) }
        let windows = appWindows().filter { isBrowser($0) && !$0.minimized && !$0.rect.isEmpty }
        let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard let selected = windows.first(where: { $0.pid == frontPid }) ?? windows.first else {
            throw HelperFailure(message: "Open Safari, Chrome, Edge, Firefox, Brave, Vivaldi, Opera or Arc on this Mac first, then ask to take over")
        }
        try activate(selected)
        let refreshed = appWindows().first(where: {
            $0.pid == selected.pid && $0.title == selected.title && isFocusedWindow($0)
        }) ?? selected
        let number = handoffNumber(refreshed)
        selectedHandoffWindow = number
        return ["text": "browser selected", "hwnd": number, "title": refreshed.title]
    }

    private func handoffList() throws -> [String: Any] {
        if let problem = accessibilityProblem() { throw HelperFailure(message: problem) }
        let windows = appWindows().filter { isBrowser($0) }
        let items: [[String: Any]] = windows.map { window in
            ["hwnd": handoffNumber(window), "title": String(window.title.prefix(200)),
             "automation": false, "minimized": window.minimized]
        }
        return ["text": "\(items.count) browser windows", "windows": items]
    }

    private func isFocusedWindow(_ window: WindowRecord) -> Bool {
        let app = AXUIElementCreateApplication(window.pid)
        guard let focused = axElement(axAttribute(app, kAXFocusedWindowAttribute as CFString)) else { return false }
        return CFEqual(focused, window.element)
    }

    private func browserInputOwner(at point: CGPoint) -> pid_t? {
        guard let list = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else { return nil }
        for item in list {
            let layer = (item[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
            guard layer == 0,
                  let owner = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let bounds = item[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { continue }
            if rect.contains(point) { return owner }
        }
        return nil
    }

    private func guardBrowserPoint(_ point: CGPoint, window: WindowRecord) throws {
        guard let owner = browserInputOwner(at: point) else {
            throw HelperFailure(message: "could not verify the frontmost window at that browser position; nothing was done")
        }
        guard owner == window.pid else {
            throw HelperFailure(message: "another application is covering the browser at that position")
        }
    }

    private func handoffWindow(_ value: Any?) throws -> WindowRecord {
        if let problem = accessibilityProblem() { throw HelperFailure(message: problem) }
        guard let number = (value as? NSNumber)?.intValue else { throw HelperFailure(message: "browser window id is required") }
        guard selectedHandoffWindow == number else { throw HelperFailure(message: "browser window was not selected for takeover") }
        guard let window = appWindows().first(where: { handoffNumber($0) == number && isBrowser($0) }) else {
            throw HelperFailure(message: "browser window is no longer available")
        }
        guard !window.minimized,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == window.pid,
              isFocusedWindow(window) else {
            throw HelperFailure(message: "browser window lost focus; bring that exact window to the front on the Mac")
        }
        return window
    }

    private func handoffFrame(_ args: [String: Any]) throws -> [String: Any] {
        let window = try handoffWindow(args["hwnd"])
        let screen = try mainScreen()
        let region = window.rect.intersection(screen.bounds)
        guard !region.isEmpty else { throw HelperFailure(message: "browser window has no visible area on the active displays") }
        let (frame, actualRegion) = screenImage(screen, region: region)
        guard let (data, _) = jpegData(frame, maxLongSide: 1200) else { throw HelperFailure(message: "cannot encode browser screenshot") }
        _ = actualRegion
        return ["text": "browser frame", "image": ["data": data.base64EncodedString(), "mimeType": "image/jpeg"]]
    }

    private func handoffInput(_ args: [String: Any]) throws -> [String: Any] {
        let window = try handoffWindow(args["hwnd"])
        try ensureEventAccess()
        let action = args["action"] as? String ?? ""
        let allowed: Set<String> = ["click", "double_click", "right_click", "drag", "scroll", "type", "key"]
        guard allowed.contains(action) else { throw HelperFailure(message: "unsupported browser input action") }
        let screen = try mainScreen()
        let region = window.rect.intersection(screen.bounds)
        guard !region.isEmpty else { throw HelperFailure(message: "browser window is not visible on the active displays") }
        func point(_ prefix: String = "") throws -> CGPoint {
            let x = (args[prefix + "x"] as? NSNumber)?.doubleValue
            let y = (args[prefix + "y"] as? NSNumber)?.doubleValue
            guard let x, let y, x.isFinite, y.isFinite, x >= 0, x <= 1, y >= 0, y <= 1 else {
                throw HelperFailure(message: "browser coordinates must be between 0 and 1")
            }
            return CGPoint(x: region.minX + CGFloat(x) * region.width, y: region.minY + CGFloat(y) * region.height)
        }
        switch action {
        case "click":
            let at = try point(); try guardBrowserPoint(at, window: window); try click(at)
        case "double_click":
            let at = try point(); try guardBrowserPoint(at, window: window); try click(at, count: 2)
        case "right_click":
            let at = try point(); try guardBrowserPoint(at, window: window); try click(at, button: .right)
        case "scroll":
            try ensureEventAccess()
            let amount = (args["amount"] as? NSNumber)?.doubleValue ?? 0
            guard amount.isFinite, abs(amount) <= 10 else { throw HelperFailure(message: "scroll amount out of range") }
            guard let event = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .combinedSessionState), units: .line,
                                      wheelCount: 2, wheel1: Int32(amount), wheel2: 0, wheel3: 0) else {
                throw HelperFailure(message: "macOS could not create the scroll event")
            }
            let at = try point()
            try guardBrowserPoint(at, window: window)
            event.location = at
            event.post(tap: .cghidEventTap)
        case "drag":
            let start = try point()
            let end = try point("to_")
            try guardBrowserPoint(start, window: window)
            try guardBrowserPoint(end, window: window)
            try postMouse(.leftMouseDown, at: start)
            for index in 1...8 {
                let t = CGFloat(index) / 8
                try postMouse(.leftMouseDragged, at: CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t))
                Thread.sleep(forTimeInterval: 0.015)
            }
            try postMouse(.leftMouseUp, at: end)
        case "type":
            guard let text = args["text"] as? String, text.count <= 2000 else { throw HelperFailure(message: "text must be at most 2000 characters") }
            _ = try handoffWindow(args["hwnd"])
            try typeText(text)
        case "key":
            guard let keys = args["keys"] as? String else { throw HelperFailure(message: "key is required") }
            _ = try handoffWindow(args["hwnd"])
            let permitted: Set<String> = ["enter", "tab", "esc", "backspace", "delete", "up", "down", "left", "right", "ctrl+a", "shift+tab", "space"]
            guard permitted.contains(keys.lowercased()) else { throw HelperFailure(message: "key not permitted for browser takeover") }
            try pressKeys(keys.lowercased() == "ctrl+a" ? "cmd+a" : keys)
        default: break
        }
        return ["text": "\(action) performed in browser"]
    }

    func handle(_ request: [String: Any]) -> [String: Any] {
        let id = request["id"] ?? NSNull()
        do {
            let method = request["method"] as? String ?? ""
            let args = request["args"] as? [String: Any] ?? [:]
            let result: [String: Any]
            switch method {
            case "permissions":
                // TCC permissions belong to this signed helper app, not the menu-bar parent.
                result = [
                    "accessibility": AXIsProcessTrusted(),
                    "screenRecording": CGPreflightScreenCaptureAccess(),
                    "eventControl": CGPreflightPostEventAccess()
                ]
            case "ping":
                if let problem = accessibilityProblem() { result = ["text": problem, "isError": true] }
                else { result = ["text": "ok", "elevated": false] }
            case "look": result = try look(args)
            case "act": result = try act(args)
            case "handoff_start": result = try handoffStart()
            case "handoff_list": result = try handoffList()
            case "handoff_select":
                if let problem = accessibilityProblem() { throw HelperFailure(message: problem) }
                let number = (args["hwnd"] as? NSNumber)?.intValue
                guard let window = appWindows().first(where: { handoffNumber($0) == number && isBrowser($0) }) else {
                    throw HelperFailure(message: "browser window is no longer available")
                }
                if window.minimized {
                    _ = AXUIElementSetAttributeValue(window.element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                }
                try activate(window)
                let refreshed = appWindows().first(where: {
                    $0.pid == window.pid && $0.title == window.title && isFocusedWindow($0)
                }) ?? window
                selectedHandoffWindow = handoffNumber(refreshed)
                result = ["text": "browser selected", "hwnd": selectedHandoffWindow!, "title": refreshed.title]
            case "handoff_frame": result = try handoffFrame(args)
            case "handoff_input": result = try handoffInput(args)
            default: result = ["text": "unknown method \(method)", "isError": true]
            }
            return ["id": id, "result": result]
        } catch let failure as HelperFailure {
            return ["id": id, "result": ["text": failure.message, "isError": true]]
        } catch {
            fputs("Wanji desktop helper error: \(error)\n", stderr)
            return ["id": id, "result": ["text": "desktop helper error: \(error)", "isError": true]]
        }
    }
}

private extension CGRect {
    var midpoint: CGPoint { CGPoint(x: midX, y: midY) }
}

private let desktop = WanjiDesktop()
while let line = readLine() {
    guard let bytes = line.data(using: .utf8),
          let request = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { continue }
    let response = desktop.handle(request)
    guard let output = try? JSONSerialization.data(withJSONObject: response, options: [.fragmentsAllowed]),
          let text = String(data: output, encoding: .utf8) else { continue }
    print(text)
    fflush(stdout)
}
