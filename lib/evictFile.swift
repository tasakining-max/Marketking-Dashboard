// Makes OneDrive files online-only again (Finder's "Free Up Space").
import Foundation
var failed = false
for p in CommandLine.arguments.dropFirst() {
  do { try FileManager.default.evictUbiquitousItem(at: URL(fileURLWithPath: p)) } catch { failed = true; FileHandle.standardError.write("\(p): \(error)\n".data(using: .utf8)!) }
}
exit(failed ? 1 : 0)
