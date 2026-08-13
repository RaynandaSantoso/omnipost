import AppKit
import Foundation

private struct BridgeMessage: Decodable {
    let type: String
    let state: String?
    let label: String?
    let detail: String?
    let openEnabled: Bool?
    let logsEnabled: Bool?
    let stopEnabled: Bool?
    let restartEnabled: Bool?
    let quitEnabled: Bool?
    let path: String?
    let message: String?
    let recovery: String?
}

@main
final class OmniPostLauncher: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let stateItem = NSMenuItem(title: "Starting", action: nil, keyEquivalent: "")
    private let detailItem = NSMenuItem(title: "Connecting to Launcher…", action: nil, keyEquivalent: "")
    private let openItem = NSMenuItem(title: "Open OmniPost", action: #selector(openOmniPost), keyEquivalent: "o")
    private let logsItem = NSMenuItem(title: "View Logs", action: #selector(viewLogs), keyEquivalent: "l")
    private let restartItem = NSMenuItem(title: "Restart", action: #selector(restartOmniPost), keyEquivalent: "r")
    private let stopItem = NSMenuItem(title: "Stop OmniPost", action: #selector(stopOmniPost), keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "Quit", action: #selector(requestQuit), keyEquivalent: "q")
    private var bridge: Process?
    private var bridgeInput: FileHandle?
    private var bufferedOutput = Data()
    private var refreshTimer: Timer?
    private var quitApproved = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        configureMenu()
        startBridge()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        send("activate")
        statusItem.button?.performClick(nil)
        return true
    }

    private func configureMenu() {
        statusItem.button?.image = NSImage(systemSymbolName: "paperplane.fill", accessibilityDescription: "OmniPost")
        statusItem.button?.toolTip = "OmniPost Launcher"

        stateItem.isEnabled = false
        detailItem.isEnabled = false
        openItem.target = self
        openItem.isEnabled = false
        logsItem.target = self
        logsItem.isEnabled = false
        restartItem.target = self
        restartItem.isEnabled = false
        stopItem.target = self
        stopItem.isEnabled = false
        quitItem.target = self
        quitItem.isEnabled = false

        let menu = NSMenu()
        menu.addItem(stateItem)
        menu.addItem(detailItem)
        menu.addItem(.separator())
        menu.addItem(openItem)
        menu.addItem(logsItem)
        menu.addItem(.separator())
        menu.addItem(restartItem)
        menu.addItem(stopItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    private func startBridge() {
        let projectDirectory = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL.path
        let nodeExecutable = CommandLine.arguments[2]
        let task = Process()
        let input = Pipe()
        let output = Pipe()
        task.executableURL = URL(fileURLWithPath: nodeExecutable)
        task.arguments = ["scripts/menu-bar/bridge.mjs", projectDirectory]
        task.currentDirectoryURL = URL(fileURLWithPath: projectDirectory)
        task.standardInput = input
        task.standardOutput = output
        task.standardError = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.receive(handle.availableData)
        }
        task.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.showFailure("The Launcher connection ended. Reopen OmniPost to try again.")
            }
        }

        do {
            try task.run()
            bridge = task
            bridgeInput = input.fileHandleForWriting
            send("activate")
            refreshTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                self?.send("status")
            }
        } catch {
            showFailure("Could not start the Launcher: \(error.localizedDescription)")
        }
    }

    private func receive(_ data: Data) {
        guard !data.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            bufferedOutput.append(data)
            while let newline = bufferedOutput.firstIndex(of: 0x0A) {
                let line = bufferedOutput.prefix(upTo: newline)
                bufferedOutput.removeSubrange(...newline)
                if let message = try? JSONDecoder().decode(BridgeMessage.self, from: line) {
                    apply(message)
                }
            }
        }
    }

    private func apply(_ message: BridgeMessage) {
        switch message.type {
        case "state":
            stateItem.title = "OmniPost: \(message.label ?? "Unknown")"
            detailItem.title = message.detail ?? ""
            openItem.isEnabled = message.openEnabled ?? false
            logsItem.isEnabled = message.logsEnabled ?? false
            stopItem.isEnabled = message.stopEnabled ?? false
            restartItem.isEnabled = message.restartEnabled ?? false
            quitItem.isEnabled = message.quitEnabled ?? false
            statusItem.button?.image = NSImage(
                systemSymbolName: message.state == "failed" ? "exclamationmark.triangle.fill" : "paperplane.fill",
                accessibilityDescription: "OmniPost \(message.label ?? "")"
            )
        case "openLog":
            if let path = message.path { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
        case "notice":
            showNotice(message.message ?? "The requested action is unavailable.")
        case "stopTimedOut":
            showStopTimeout(message)
        case "confirmForceStop":
            confirmForceStop(message)
        case "quitReady":
            quitApproved = true
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func send(_ action: String) {
        guard let data = "\(action)\n".data(using: .utf8) else { return }
        try? bridgeInput?.write(contentsOf: data)
    }

    private func showFailure(_ detail: String) {
        stateItem.title = "OmniPost: Failed"
        detailItem.title = detail
        openItem.isEnabled = false
        stopItem.isEnabled = false
        restartItem.isEnabled = false
        statusItem.button?.image = NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: "OmniPost Failed")
    }

    private func showNotice(_ text: String) {
        let alert = NSAlert()
        alert.messageText = "OmniPost Launcher"
        alert.informativeText = text
        alert.runModal()
    }

    @objc private func openOmniPost() { send("open") }
    @objc private func viewLogs() { send("viewLogs") }
    @objc private func stopOmniPost() { send("stop") }
    @objc private func restartOmniPost() { send("restart") }

    @objc private func requestQuit() {
        let alert = NSAlert()
        alert.messageText = "Quit OmniPost?"
        alert.informativeText = "The complete OmniPost runtime will stop before the Launcher exits. Active work may need time to finish."
        alert.addButton(withTitle: "Stop and Quit")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { send("quit") }
    }

    private func showStopTimeout(_ message: BridgeMessage) {
        let alert = NSAlert()
        alert.messageText = "OmniPost is still stopping"
        alert.informativeText = [message.message, message.recovery].compactMap { $0 }.joined(separator: "\n\n")
        alert.addButton(withTitle: "Keep Waiting")
        alert.addButton(withTitle: "Force Stop…")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn: send("keepWaiting")
        case .alertSecondButtonReturn: send("requestForceStop")
        default: break
        }
    }

    private func confirmForceStop(_ message: BridgeMessage) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Force Stop OmniPost?"
        alert.informativeText = [message.message, message.recovery].compactMap { $0 }.joined(separator: "\n\n")
        alert.addButton(withTitle: "Keep Waiting")
        alert.addButton(withTitle: "Force Stop")
        switch alert.runModal() {
        case .alertSecondButtonReturn: send("confirmForceStop")
        default: send("keepWaiting")
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitApproved { return .terminateNow }
        requestQuit()
        return .terminateCancel
    }
}
