/**
 * OpenBrowser - 打开浏览器，macOS 上优先复用已打开的 Dashboard 标签
 *
 * V2 ESM 版本，对应 V1 OpenBrowser.js
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function isAppInstalled(appName) {
  if (process.platform !== 'darwin') {
    return false;
  }
  const candidates = [
    `/Applications/${appName}.app`,
    `${homedir()}/Applications/${appName}.app`,
    `/System/Applications/${appName}.app`,
  ];
  return candidates.some((p) => existsSync(p));
}

/**
 * 检测当前进程是否已有控制 Chromium 系浏览器的权限
 */
export function hasMacOSBrowserControlGranted() {
  if (process.platform !== 'darwin') {
    return false;
  }
  const chromiumBrowsers = [
    'Google Chrome Canary',
    'Google Chrome',
    'Microsoft Edge',
    'Brave Browser',
    'Vivaldi',
    'Chromium',
  ];
  for (const browser of chromiumBrowsers) {
    if (!isAppInstalled(browser)) {
      continue;
    }
    try {
      execSync(`osascript -e 'tell application "${browser}" to get name'`, {
        stdio: 'ignore',
      });
      return true;
    } catch {
      // 未安装或未授权
    }
  }
  return false;
}

/**
 * macOS 上尝试复用已打开的同 URL 标签，失败则用 open 新开
 *
 * @param {string} url 要打开的地址
 * @param {string} [baseUrlForLookup] 可选 base URL，按 base 查找标签后导航到 url
 */
export function openBrowserReuseTab(url, baseUrlForLookup) {
  const skipReuse =
    process.env.ASD_UI_NO_REUSE_TAB === '1' || process.env.ASD_UI_OPEN_REUSE === '0';

  if (skipReuse) {
    _fallbackOpen(url);
    return;
  }

  if (process.platform === 'darwin') {
    const chromiumBrowsers = [
      'Google Chrome Canary',
      'Google Chrome',
      'Microsoft Edge',
      'Brave Browser',
      'Vivaldi',
      'Chromium',
    ];
    const availableChromium = chromiumBrowsers.filter(isAppInstalled);
    const scriptPath = join(__dirname, '../../../resources/openChrome.applescript');

    if (!existsSync(scriptPath)) {
      _fallbackOpen(url);
      return;
    }

    if (!hasMacOSBrowserControlGranted()) {
    }

    const lookupUrl = baseUrlForLookup || url;
    for (const browser of availableChromium) {
      try {
        const args =
          lookupUrl !== url ? [scriptPath, lookupUrl, url, browser] : [scriptPath, url, browser];
        execFileSync('osascript', args, {
          cwd: dirname(scriptPath),
          stdio: 'pipe',
          timeout: 3000,
        });
        return;
      } catch (_err) {
        if (process.env.ASD_DEBUG === '1') {
        }
      }
    }
  }

  // 所有 AppleScript 尝试失败或非 macOS
  _fallbackOpen(url);
}

/**
 * 回退 open 方式
 */
async function _fallbackOpen(url) {
  try {
    const open = (await import('open')).default;
    open(url).catch((err) => {
      console.error(`⚠️ 打开浏览器失败: ${err.message}`);
    });
  } catch (err) {
    console.error(`⚠️ 打开浏览器失败: ${err.message}`);
  }
}
