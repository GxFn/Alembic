import Foundation
import ScreenCaptureKit
import AppKit
import CoreGraphics

/**
 * AutoSnippet Screenshot Tool
 *
 * 使用 macOS ScreenCaptureKit 原生 API 截取窗口/屏幕画面。
 * 息屏时可用（不依赖显示器输出）。无需 OBS。
 *
 * Usage:
 *   screenshot                            # 截取整个主屏幕
 *   screenshot --window "Visual Studio Code"  # 截取匹配标题的窗口
 *   screenshot --list-windows             # 列出所有可截取窗口 (JSON)
 *   screenshot --output /tmp/shot.png     # 指定输出路径
 *   screenshot --format jpeg              # 指定格式 (png|jpeg)
 *   screenshot --scale 0.5               # 缩放因子
 *
 * Requirements: macOS 12.3+, Screen Recording permission
 */

// MARK: - 输出格式
enum ImageFormat: String {
    case png, jpeg
}

// MARK: - 参数解析
struct Args {
    var windowTitle: String? = nil
    var listWindows = false
    var outputPath: String? = nil
    var format: ImageFormat = .jpeg
    var scale: CGFloat = 1.0

    static func parse(_ args: [String]) -> Args {
        var result = Args()
        var i = 1 // skip executable name
        while i < args.count {
            switch args[i] {
            case "--window", "-w":
                i += 1
                if i < args.count { result.windowTitle = args[i] }
            case "--list-windows", "-l":
                result.listWindows = true
            case "--output", "-o":
                i += 1
                if i < args.count { result.outputPath = args[i] }
            case "--format", "-f":
                i += 1
                if i < args.count {
                    result.format = ImageFormat(rawValue: args[i].lowercased()) ?? .jpeg
                }
            case "--scale", "-s":
                i += 1
                if i < args.count { result.scale = CGFloat(Double(args[i]) ?? 1.0) }
            case "--help", "-h":
                printUsage()
                exit(0)
            default:
                break
            }
            i += 1
        }
        return result
    }

    static func printUsage() {
        let usage = """
        AutoSnippet Screenshot Tool (ScreenCaptureKit)

        Usage:
          screenshot                               Capture main screen
          screenshot --window "Code"               Capture window matching title
          screenshot --list-windows                List capturable windows (JSON)
          screenshot --output /path/to/file.png    Specify output path
          screenshot --format jpeg|png             Image format (default: jpeg)
          screenshot --scale 0.5                   Scale factor (default: 1.0)
        """
        fputs(usage + "\n", stderr)
    }
}

// MARK: - 主逻辑

@available(macOS 12.3, *)
func run() async {
    let args = Args.parse(CommandLine.arguments)

    // 获取可共享内容（窗口/屏幕列表）
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
        fputs("{\"error\":\"ScreenCaptureKit access denied: \\(error.localizedDescription). Grant Screen Recording permission in System Settings.\"}\n", stderr)
        exit(1)
    }

    // --list-windows: 输出 JSON 窗口列表
    if args.listWindows {
        let windows = content.windows.compactMap { w -> [String: Any]? in
            guard let app = w.owningApplication else { return nil }
            return [
                "windowID": w.windowID,
                "title": w.title ?? "",
                "app": app.applicationName,
                "bundleID": app.bundleIdentifier,
                "width": w.frame.width,
                "height": w.frame.height,
                "onScreen": w.isOnScreen,
            ]
        }
        if let data = try? JSONSerialization.data(withJSONObject: windows, options: [.prettyPrinted, .sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            print(json)
        }
        exit(0)
    }

    // 确定截取目标 — 统一使用 desktopIndependentWindow（亮屏/息屏均可用）
    var filter: SCContentFilter

    // 筛选有效窗口（面积 > 100x100，排除菜单栏等微型窗口）
    let validWindows = content.windows.filter { $0.frame.width > 100 && $0.frame.height > 100 }

    if let title = args.windowTitle {
        // 模糊匹配窗口标题或 app 名，选面积最大的
        let pattern = title.lowercased()
        let candidates = validWindows.filter { w in
            let wTitle = (w.title ?? "").lowercased()
            let appName = (w.owningApplication?.applicationName ?? "").lowercased()
            return wTitle.contains(pattern) || appName.contains(pattern)
        }
        let matched = candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })

        guard let window = matched else {
            let windowList: String = validWindows.prefix(20).compactMap {
                "\($0.owningApplication?.applicationName ?? "?") - \($0.title ?? "(no title)") [\(Int($0.frame.width))x\(Int($0.frame.height))]"
            }.joined(separator: "\n  ")
            fputs("{\"error\":\"No window matching '\(title)'. Available:\\n  \(windowList)\"}\n", stderr)
            exit(1)
        }

        filter = SCContentFilter(desktopIndependentWindow: window)
    } else {
        // 未指定窗口 — 自动选最大窗口
        guard let largest = validWindows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            fputs("{\"error\":\"No capturable window available\"}\n", stderr)
            exit(1)
        }
        filter = SCContentFilter(desktopIndependentWindow: largest)
    }

    // 配置截图参数
    let config = SCStreamConfiguration()
    let sourceRect = filter.contentRect
    config.width = Int(sourceRect.width * args.scale)
    config.height = Int(sourceRect.height * args.scale)
    config.showsCursor = false
    config.capturesAudio = false

    // 截图
    let image: CGImage
    do {
        image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    } catch {
        fputs("{\"error\":\"Screenshot failed: \\(error.localizedDescription)\"}\n", stderr)
        exit(1)
    }

    // 编码为图片数据
    let bitmapRep = NSBitmapImageRep(cgImage: image)
    let imageData: Data?
    switch args.format {
    case .jpeg:
        imageData = bitmapRep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
    case .png:
        imageData = bitmapRep.representation(using: .png, properties: [:])
    }

    guard let data = imageData else {
        fputs("{\"error\":\"Image encoding failed\"}\n", stderr)
        exit(1)
    }

    // 确定输出路径
    let ext = args.format == .png ? "png" : "jpg"
    let outputPath = args.outputPath ?? NSTemporaryDirectory() + "asd-screenshot-\(Int(Date().timeIntervalSince1970 * 1000)).\(ext)"

    do {
        try data.write(to: URL(fileURLWithPath: outputPath))
    } catch {
        fputs("{\"error\":\"Write failed: \\(error.localizedDescription)\"}\n", stderr)
        exit(1)
    }

    // 输出 JSON 结果到 stdout
    let result: [String: Any] = [
        "success": true,
        "path": outputPath,
        "width": image.width,
        "height": image.height,
        "format": args.format.rawValue,
        "bytes": data.count,
    ]
    if let jsonData = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
       let json = String(data: jsonData, encoding: .utf8) {
        print(json)
    }
}

// MARK: - Entry Point

// 初始化 AppKit 连接到 WindowServer（解决 CGS_REQUIRE_INIT）
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

if #available(macOS 12.3, *) {
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        await run()
        semaphore.signal()
    }
    semaphore.wait()
} else {
    fputs("{\"error\":\"Requires macOS 12.3 or later\"}\n", stderr)
    exit(1)
}
