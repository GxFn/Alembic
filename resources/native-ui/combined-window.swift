import AppKit
import Foundation

/**
 * AutoSnippet 组合窗口 - 列表 + 预览一体化
 * 左侧：搜索结果列表
 * 右侧：代码预览（实时更新）
 * 底部：操作按钮
 */

// MARK: - 语法高亮

struct SyntaxHighlighter {
    static let keywords = ["func", "var", "let", "if", "else", "guard", "return", "import", "class", "struct", "enum", "protocol", "extension", "private", "public", "internal", "fileprivate", "static", "override", "init", "deinit", "self", "super", "nil", "true", "false", "for", "while", "repeat", "switch", "case", "default", "break", "continue", "fallthrough", "where", "in", "throws", "throw", "try", "catch", "async", "await", "typealias", "associatedtype", "weak", "unowned", "lazy", "final", "required", "convenience", "mutating", "nonmutating", "open", "inout", "some", "any",
        // Objective-C
        "@interface", "@implementation", "@end", "@property", "@synthesize", "@dynamic", "@class", "@protocol", "@optional", "@required", "@public", "@private", "@protected", "@package", "@selector", "@encode", "@synchronized", "@autoreleasepool", "@try", "@catch", "@finally", "@throw", "YES", "NO", "NULL", "nil", "self", "super", "id", "Class", "SEL", "IMP", "BOOL", "instancetype", "void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "const", "static", "extern", "auto", "register", "volatile", "inline", "restrict", "typedef", "sizeof", "typeof", "return", "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "goto", "struct", "union", "enum",
        // TypeScript/JavaScript
        "function", "const", "async", "await", "new", "this", "typeof", "instanceof", "export", "import", "from", "as", "default", "extends", "implements", "interface", "type", "namespace", "module", "declare", "abstract", "readonly", "keyof", "infer", "never", "unknown", "any", "void", "null", "undefined", "number", "string", "boolean", "symbol", "bigint", "object"
    ]

    static let typeKeywords = ["String", "Int", "Double", "Float", "Bool", "Array", "Dictionary", "Set", "Optional", "Any", "AnyObject", "Void", "Never", "Error", "Result", "URL", "Data", "Date", "UUID", "NSObject", "NSString", "NSNumber", "NSArray", "NSDictionary", "NSSet", "NSData", "NSDate", "NSURL", "CGFloat", "CGPoint", "CGSize", "CGRect", "UIView", "UIViewController", "UIButton", "UILabel", "UIImage", "UIColor", "NSView", "NSViewController", "NSButton", "NSTextField", "NSImage", "NSColor", "Promise", "Observable", "Subject"]

    static func highlight(_ code: String) -> NSAttributedString {
        let attributed = NSMutableAttributedString(string: code)
        let fullRange = NSRange(location: 0, length: code.utf16.count)

        // 基础样式 - SF Mono 字体 (Xcode 默认) - 增大到 14
        let baseFont = NSFont(name: "SFMono-Regular", size: 14) ?? NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        // 普通文本 - Xcode 默认浅灰白色
        let baseColor = NSColor(calibratedRed: 0.83, green: 0.84, blue: 0.85, alpha: 1.0) // #D4D4D6
        attributed.addAttribute(.font, value: baseFont, range: fullRange)
        attributed.addAttribute(.foregroundColor, value: baseColor, range: fullRange)

        // 高亮注释 - Xcode 默认绿色 (系统 Green)
        let commentColor = NSColor(calibratedRed: 0.42, green: 0.75, blue: 0.31, alpha: 1.0) // #6BBF4F
        highlightPattern(attributed, pattern: "//.*$", color: commentColor, options: .anchorsMatchLines)
        highlightPattern(attributed, pattern: "/\\*[\\s\\S]*?\\*/", color: commentColor)

        // 高亮字符串 - Xcode 默认橙红色 (系统 Red/Orange 混合)
        let stringColor = NSColor(calibratedRed: 0.98, green: 0.42, blue: 0.33, alpha: 1.0) // #FA6B54
        highlightPattern(attributed, pattern: "\"(?:[^\"\\\\]|\\\\.)*\"", color: stringColor)
        highlightPattern(attributed, pattern: "'(?:[^'\\\\]|\\\\.)*'", color: stringColor)
        highlightPattern(attributed, pattern: "@\"(?:[^\"\\\\]|\\\\.)*\"", color: stringColor) // ObjC string

        // 高亮数字 - Xcode 默认紫色 (Light Purple)
        let numberColor = NSColor(calibratedRed: 0.69, green: 0.54, blue: 0.89, alpha: 1.0) // #B08AE3
        highlightPattern(attributed, pattern: "\\b\\d+\\.?\\d*\\b", color: numberColor)

        // 高亮类型关键字 - Xcode 默认青绿色 (Teal/Cyan)
        let typeColor = NSColor(calibratedRed: 0.40, green: 0.84, blue: 0.89, alpha: 1.0) // #66D7E3
        for keyword in typeKeywords {
            highlightWord(attributed, word: keyword, color: typeColor)
        }

        // 高亮关键字 - Xcode 默认粉紫色 (Magenta/Pink)
        let keywordColor = NSColor(calibratedRed: 0.98, green: 0.42, blue: 0.69, alpha: 1.0) // #FA6BB0
        // Objective-C @ 前缀关键字 - 使用浅棕色
        let atKeywordColor = NSColor(calibratedRed: 0.83, green: 0.60, blue: 0.45, alpha: 1.0) // #D49973
        for keyword in keywords {
            if keyword.hasPrefix("@") {
                highlightPattern(attributed, pattern: "\(keyword)\\b", color: atKeywordColor)
            } else {
                highlightWord(attributed, word: keyword, color: keywordColor)
            }
        }

        return attributed
    }

    private static func highlightPattern(_ attributed: NSMutableAttributedString, pattern: String, color: NSColor, options: NSRegularExpression.Options = []) {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return }
        let string = attributed.string
        let range = NSRange(location: 0, length: string.utf16.count)

        for match in regex.matches(in: string, options: [], range: range) {
            attributed.addAttribute(.foregroundColor, value: color, range: match.range)
        }
    }

    private static func highlightWord(_ attributed: NSMutableAttributedString, word: String, color: NSColor) {
        let pattern = "\\b\(NSRegularExpression.escapedPattern(for: word))\\b"
        highlightPattern(attributed, pattern: pattern, color: color)
    }
}

// MARK: - 数据结构

struct SearchItem {
    let title: String
    let code: String
    let explanation: String
    let groupSize: Int
}

// MARK: - Combined Window Controller

class CombinedSearchWindowController: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    private var panel: NSPanel!
    private var tableView: NSTableView!
    private var searchField: NSSearchField!
    private var codeTextView: NSTextView!
    private var allItems: [SearchItem] = []
    private var filteredItems: [SearchItem] = []
    private var selectedIndex: Int = -1
    private var confirmed: Bool = false
    
    enum Result {
        case confirmed(Int)  // 用户确认插入，返回选中的索引
        case cancelled       // 用户取消
    }
    
    func show(items: [SearchItem], keyword: String) -> Result {
        self.allItems = items
        self.filteredItems = items
        
        let panelWidth: CGFloat = 1400
        let panelHeight: CGFloat = 680
        
        // 创建面板
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "AutoSnippet 搜索结果"
        panel.level = .floating
        panel.center()
        panel.minSize = NSSize(width: 1000, height: 500)
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        
        // 模糊背景
        let visualEffect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight))
        visualEffect.material = .hudWindow
        visualEffect.blendingMode = .behindWindow
        visualEffect.state = .active
        visualEffect.autoresizingMask = [.width, .height]
        panel.contentView = visualEffect
        
        let contentView = NSView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight))
        contentView.autoresizingMask = [.width, .height]
        visualEffect.addSubview(contentView)
        
        // 顶部标题和搜索框
        let titleLabel = NSTextField(labelWithString: "找到 \(items.count) 个匹配")
        titleLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        titleLabel.textColor = .secondaryLabelColor
        titleLabel.frame = NSRect(x: 20, y: panelHeight - 50, width: 200, height: 20)
        titleLabel.autoresizingMask = [.minYMargin]
        contentView.addSubview(titleLabel)
        
        // 搜索框
        searchField = NSSearchField(frame: NSRect(x: 20, y: panelHeight - 85, width: 350, height: 28))
        searchField.placeholderString = "过滤结果..."
        searchField.stringValue = keyword
        searchField.autoresizingMask = [.width, .minYMargin]
        searchField.target = self
        searchField.action = #selector(searchFieldDidChange)
        searchField.font = NSFont.systemFont(ofSize: 13)
        contentView.addSubview(searchField)
        
        // 分隔线
        let separator = NSBox(frame: NSRect(x: 0, y: panelHeight - 95, width: panelWidth, height: 1))
        separator.boxType = .separator
        separator.autoresizingMask = [.width, .minYMargin]
        contentView.addSubview(separator)
        
        // 左侧：列表区域
        let listWidth: CGFloat = 360
        let listScrollView = NSScrollView(frame: NSRect(x: 20, y: 70, width: listWidth, height: panelHeight - 175))
        listScrollView.hasVerticalScroller = true
        listScrollView.borderType = .noBorder
        listScrollView.autoresizingMask = [.height, .minYMargin]
        listScrollView.wantsLayer = true
        listScrollView.layer?.cornerRadius = 8
        listScrollView.layer?.masksToBounds = true
        listScrollView.backgroundColor = NSColor(calibratedRed: 0.12, green: 0.12, blue: 0.14, alpha: 1.0)
        // 使用现代 overlay 滚动条样式（悬浮自动隐藏）
        listScrollView.scrollerStyle = .overlay
        listScrollView.autohidesScrollers = true
        listScrollView.scrollerKnobStyle = .light
        // 强制刷新滚动条样式
        listScrollView.flashScrollers()
        
        tableView = NSTableView()
        tableView.headerView = nil
        tableView.rowHeight = 60
        tableView.intercellSpacing = NSSize(width: 0, height: 2)
        tableView.backgroundColor = NSColor(calibratedRed: 0.12, green: 0.12, blue: 0.14, alpha: 1.0)
        tableView.usesAlternatingRowBackgroundColors = false
        tableView.selectionHighlightStyle = .regular
        tableView.target = self
        tableView.action = #selector(tableViewClicked)
        tableView.doubleAction = #selector(tableViewDoubleClicked)
        
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("item"))
        column.width = listWidth - 25
        tableView.addTableColumn(column)
        
        tableView.dataSource = self
        tableView.delegate = self
        
        listScrollView.documentView = tableView
        contentView.addSubview(listScrollView)
        
        // 右侧：代码预览区域
        let codeX = 20 + listWidth + 15
        let codeWidth = panelWidth - codeX - 20
        
        let previewLabel = NSTextField(labelWithString: "代码预览")
        previewLabel.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        previewLabel.textColor = .secondaryLabelColor
        previewLabel.frame = NSRect(x: codeX, y: panelHeight - 115, width: codeWidth, height: 16)
        previewLabel.autoresizingMask = [.width, .minYMargin]
        contentView.addSubview(previewLabel)
        
        let codeScrollView = NSScrollView(frame: NSRect(x: codeX, y: 70, width: codeWidth, height: panelHeight - 195))
        codeScrollView.hasVerticalScroller = true
        codeScrollView.hasHorizontalScroller = true
        codeScrollView.borderType = .noBorder
        codeScrollView.autoresizingMask = [.width, .height]
        codeScrollView.wantsLayer = true
        codeScrollView.layer?.cornerRadius = 8
        codeScrollView.layer?.masksToBounds = true
        codeScrollView.backgroundColor = NSColor(calibratedRed: 0.12, green: 0.12, blue: 0.14, alpha: 1.0)
        // 使用现代 overlay 滚动条样式（悬浮自动隐藏）
        codeScrollView.scrollerStyle = .overlay
        codeScrollView.autohidesScrollers = true
        codeScrollView.scrollerKnobStyle = .light
        // 启用平滑滚动
        codeScrollView.usesPredominantAxisScrolling = false
        codeScrollView.horizontalScrollElasticity = .automatic
        codeScrollView.verticalScrollElasticity = .automatic
        // 强制刷新滚动条样式
        codeScrollView.flashScrollers()
        
        codeTextView = NSTextView(frame: codeScrollView.bounds)
        codeTextView.isEditable = false
        codeTextView.isSelectable = true
        codeTextView.backgroundColor = NSColor(calibratedRed: 0.12, green: 0.12, blue: 0.14, alpha: 1.0)
        codeTextView.textContainerInset = NSSize(width: 16, height: 16)
        codeTextView.isHorizontallyResizable = true
        codeTextView.isVerticallyResizable = true
        codeTextView.textContainer?.widthTracksTextView = false
        codeTextView.textContainer?.heightTracksTextView = false
        codeTextView.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        codeTextView.autoresizingMask = []
        codeTextView.textContainer?.lineFragmentPadding = 10
        // 设置默认字体大小
        codeTextView.font = NSFont(name: "SFMono-Regular", size: 14) ?? NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        
        if let textContainer = codeTextView.textContainer {
            textContainer.size = NSSize(width: codeScrollView.bounds.width - 40, height: CGFloat.greatestFiniteMagnitude)
        }
        
        codeScrollView.documentView = codeTextView
        contentView.addSubview(codeScrollView)
        
        // 底部按钮
        let buttonY: CGFloat = 20
        
        let cancelButton = NSButton(title: "取消", target: self, action: #selector(cancelClicked))
        cancelButton.bezelStyle = .rounded
        cancelButton.frame = NSRect(x: panelWidth - 310, y: buttonY, width: 90, height: 32)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.autoresizingMask = [.minXMargin, .maxYMargin]
        cancelButton.wantsLayer = true
        cancelButton.layer?.cornerRadius = 6
        contentView.addSubview(cancelButton)
        
        let copyButton = NSButton(title: "复制代码", target: self, action: #selector(copyClicked))
        copyButton.bezelStyle = .rounded
        copyButton.frame = NSRect(x: panelWidth - 210, y: buttonY, width: 90, height: 32)
        copyButton.autoresizingMask = [.minXMargin, .maxYMargin]
        copyButton.wantsLayer = true
        copyButton.layer?.cornerRadius = 6
        contentView.addSubview(copyButton)
        
        let okButton = NSButton(title: "立即插入", target: self, action: #selector(okClicked))
        okButton.bezelStyle = .rounded
        okButton.frame = NSRect(x: panelWidth - 110, y: buttonY, width: 90, height: 32)
        okButton.keyEquivalent = "\r"
        okButton.autoresizingMask = [.minXMargin, .maxYMargin]
        okButton.wantsLayer = true
        okButton.layer?.cornerRadius = 6
        contentView.addSubview(okButton)
        
        // 初始化显示
        tableView.reloadData()
        if !filteredItems.isEmpty {
            tableView.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
            updatePreview(index: 0)
        } else {
            showEmptyPreview()
        }
        
        // 显示窗口
        panel.alphaValue = 0
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(searchField)
        
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.2
            panel.animator().alphaValue = 1.0
        })
        
        NSApp.runModal(for: panel)
        
        // 返回结果
        if confirmed && selectedIndex >= 0 {
            // 找到在原始数组中的索引
            if let selected = filteredItems[safe: selectedIndex] {
                if let originalIndex = allItems.firstIndex(where: { $0.title == selected.title }) {
                    return .confirmed(originalIndex)
                }
            }
            return .confirmed(selectedIndex)
        }
        return .cancelled
    }
    
    // MARK: - Table View Data Source
    
    func numberOfRows(in tableView: NSTableView) -> Int {
        return filteredItems.count
    }
    
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let item = filteredItems[row]
        
        let cellView = NSTableCellView()
        cellView.wantsLayer = true
        
        // 标题 - 自动折行，最多两行，右侧留出足够边距
        let textField = NSTextField(labelWithString: item.title)
        textField.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        textField.textColor = .labelColor
        textField.lineBreakMode = .byWordWrapping
        textField.maximumNumberOfLines = 2  // 必须两行保证显示全
        textField.frame = NSRect(x: 12, y: 24, width: tableView.bounds.width - 56, height: 36)
        cellView.addSubview(textField)
        
        // 说明
        var subtitleParts: [String] = []
        if item.groupSize > 1 {
            subtitleParts.append("同类\(item.groupSize)")
        }
        if !item.explanation.isEmpty {
            subtitleParts.append(item.explanation)
        }
        let subtitle = subtitleParts.joined(separator: " · ")
        if !subtitle.isEmpty {
            let subtitleField = NSTextField(labelWithString: subtitle)
            subtitleField.font = NSFont.systemFont(ofSize: 11, weight: .regular)
            subtitleField.textColor = .secondaryLabelColor
            subtitleField.lineBreakMode = .byTruncatingTail
            subtitleField.frame = NSRect(x: 12, y: 8, width: tableView.bounds.width - 56, height: 16)
            cellView.addSubview(subtitleField)
        }
        
        return cellView
    }
    
    func tableViewSelectionDidChange(_ notification: Notification) {
        let row = tableView.selectedRow
        if row >= 0 {
            selectedIndex = row
            updatePreview(index: row)
        }
    }
    
    // MARK: - Actions
    
    @objc func tableViewClicked() {
        let row = tableView.clickedRow
        if row >= 0 {
            selectedIndex = row
            updatePreview(index: row)
        }
    }
    
    @objc func tableViewDoubleClicked() {
        let row = tableView.clickedRow
        if row >= 0 {
            selectedIndex = row
            confirmed = true
            panel.close()
            NSApp.stopModal()
        }
    }
    
    @objc func searchFieldDidChange() {
        let query = searchField.stringValue.lowercased().trimmingCharacters(in: .whitespaces)
        
        if query.isEmpty {
            filteredItems = allItems
        } else {
            filteredItems = allItems.filter { $0.title.lowercased().contains(query) }
        }
        
        tableView.reloadData()
        
        if !filteredItems.isEmpty {
            tableView.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
            selectedIndex = 0
            updatePreview(index: 0)
        } else {
            showEmptyPreview()
        }
    }
    
    @objc func cancelClicked() {
        confirmed = false
        panel.close()
        NSApp.stopModal()
    }
    
    @objc func copyClicked() {
        if selectedIndex >= 0, let item = filteredItems[safe: selectedIndex] {
            let pureCode = extractPureCode(item.code)
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(pureCode, forType: .string)
            print("✅ 代码已复制到剪贴板")
            // 复制后也关闭窗口
            confirmed = true
            panel.close()
            NSApp.stopModal()
        }
    }
    
    @objc func okClicked() {
        if selectedIndex >= 0 {
            confirmed = true
            // 复制代码到剪贴板
            if let item = filteredItems[safe: selectedIndex] {
                let pureCode = extractPureCode(item.code)
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(pureCode, forType: .string)
            }
            panel.close()
            NSApp.stopModal()
        }
    }
    
    // MARK: - Helper Methods
    
    private func updatePreview(index: Int) {
        guard let item = filteredItems[safe: index] else {
            showEmptyPreview()
            return
        }
        
        let processedCode = item.code.replacingOccurrences(of: "\\n", with: "\n")
        let highlightedCode = SyntaxHighlighter.highlight(processedCode)
        codeTextView.textStorage?.setAttributedString(highlightedCode)
    }
    
    private func showEmptyPreview() {
        let emptyText = NSAttributedString(
            string: "无内容",
            attributes: [
                .font: NSFont.systemFont(ofSize: 14),
                .foregroundColor: NSColor.tertiaryLabelColor
            ]
        )
        codeTextView.textStorage?.setAttributedString(emptyText)
    }
    
    private func extractPureCode(_ code: String) -> String {
        var lines = code.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        
        // 移除首尾的代码块标记（```swift、```等）
        while !lines.isEmpty && (lines.first?.trimmingCharacters(in: .whitespaces).starts(with: "```") ?? false) {
            lines.removeFirst()
        }
        while !lines.isEmpty && (lines.last?.trimmingCharacters(in: .whitespaces).starts(with: "```") ?? false) {
            lines.removeLast()
        }
        
        return lines.joined(separator: "\n")
    }
}

// MARK: - Array Safe Subscript

extension Array {
    subscript(safe index: Int) -> Element? {
        return indices.contains(index) ? self[index] : nil
    }
}
