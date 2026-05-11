(*
  用于 asd ui / watch (as:create、as:search)：在 macOS 上优先复用已打开的 Dashboard 标签，
  找不到则新建标签。支持「按 base URL 查找 → 找到则导航到目标 URL」以复用已有前端。
  用法:
    osascript openChrome.applescript "URL" ["浏览器名称"]
    osascript openChrome.applescript "lookupBase" "targetUrl" "浏览器名称"  -- 按 base 查找，导航到 target
*)
property targetTab: null
property targetTabIndex: -1
property targetWindow: null
property theProgram: "Google Chrome"

on run argv
	set lookupUrl to item 1 of argv
	set targetUrl to lookupUrl
	if (count of argv) = 3 then
		-- lookupBase, targetUrl, browser
		set targetUrl to item 2 of argv
		set theProgram to item 3 of argv
	else if (count of argv) = 2 then
		-- url, browser
		set theProgram to item 2 of argv
	end if

	using terms from application "Google Chrome"
		tell application theProgram
			if (count every window) = 0 then
				make new window
			end if

			-- 1: 查找已打开包含 lookupUrl 的标签
			set found to my lookupTabWithUrl(lookupUrl)
			if found then
				-- 复用：激活并导航到目标 URL（支持 as:create / as:search 复用已有 Dashboard 标签）
				set targetWindow's active tab index to targetTabIndex
				set index of targetWindow to 1
				activate
				set targetTab's URL to targetUrl
				return
			end if

			-- 2: 未找到则新开标签
			tell window 1
				activate
				make new tab with properties {URL:targetUrl}
			end tell
		end tell
	end using terms from
end run

on lookupTabWithUrl(lookupUrl)
	using terms from application "Google Chrome"
		tell application theProgram
			set found to false
			set theTabIndex to -1
			repeat with theWindow in every window
				set theTabIndex to 0
				repeat with theTab in every tab of theWindow
					set theTabIndex to theTabIndex + 1
					if (theTab's URL as string) contains lookupUrl then
						set targetTab to theTab
						set targetTabIndex to theTabIndex
						set targetWindow to theWindow
						set found to true
						exit repeat
					end if
				end repeat
				if found then
					exit repeat
				end if
			end repeat
		end tell
	end using terms from
	return found
end lookupTabWithUrl
