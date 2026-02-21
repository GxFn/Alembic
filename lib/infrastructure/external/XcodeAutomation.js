/**
 * @deprecated Moved to lib/platform/ios/xcode/XcodeAutomation.js
 * This re-export shim maintains backward compatibility.
 */
export {
  isXcodeRunning,
  isXcodeFrontmost,
  jumpToLineInXcode,
  cutLineInXcode,
  deleteLineContentInXcode,
  pasteInXcode,
  selectAndPasteInXcode,
  insertAtLineStartInXcode,
  saveActiveDocumentInXcode,
} from '../../platform/ios/xcode/XcodeAutomation.js';
