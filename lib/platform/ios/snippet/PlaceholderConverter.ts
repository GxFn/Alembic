/**
 * PlaceholderConverter — Xcode <#…#> ↔ VSCode ${N:…} 双向占位符转换
 *
 * 转换规则:
 *   Xcode → VSCode:
 *     <#name#>            → ${1:name}     (序号自动递增)
 *     <#T##Type#>         → ${1:Type}     (取最后一段)
 *     <#T##Label##Type#>  → ${1:Label}    (取 Label 段)
 *
 *   VSCode → Xcode:
 *     ${1:name}           → <#name#>
 *     ${1}                → <#value#>
 *     $1                  → <#value#>
 *     $0                  → (移除，Xcode 无终止光标)
 */
export class PlaceholderConverter {
  /**
   * Xcode → VSCode 占位符转换
   * @param {string} code
   * @returns {string}
   */
  static xcodeToVSCode(code: string): string {
    if (!code) {
      return '';
    }
    let index = 0;
    return code.replace(/<#(.*?)#>/g, (_match: string, inner: string) => {
      index++;
      // <#T##Label##Type#> → Label (parts[1])
      // <#T##Type#>        → Type  (parts[1])
      // <#name#>           → name  (inner)
      const parts = inner.split('##');
      const label = parts.length >= 2 ? parts[1] : inner;
      return `\${${index}:${label}}`;
    });
  }

  /**
   * VSCode → Xcode 占位符转换
   * @param {string} code
   * @returns {string}
   */
  static vscodeToXcode(code: string): string {
    if (!code) {
      return '';
    }
    return (
      code
        // ${1:name} → <#name#>
        .replace(/\$\{(\d+):([^}]*)}/g, (_m: string, _n: string, label: string) => `<#${label}#>`)
        // ${1} → <#value#>
        .replace(/\$\{(\d+)}/g, '<#value#>')
        // $0 → remove (Xcode has no final cursor)
        .replace(/\$0/g, '')
        // $1..$9 → <#value#>
        .replace(/\$([1-9]\d*)/g, '<#value#>')
    );
  }
}
