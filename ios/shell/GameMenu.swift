// Adapted from NX2Apple / nxnative GameMenu.swift, MIT.
// See overlay/LICENSE and overlay/SOURCE.json for exact source attribution.
// Only nx2ipa's implemented controls are offered. No launcher-only settings.
import UIKit

@MainActor
@_cdecl("nx2ipa_game_menu")
public func nx2ipaGameMenu() -> UnsafeMutableRawPointer {
    let menu = UIMenu(children: [UIDeferredMenuElement.uncached { done in
        done(gameMenuItems())
    }])
    return Unmanaged.passRetained(menu).toOpaque()
}

@MainActor
private func gameMenuItems() -> [UIMenuElement] {
    let names = ["2D", "3D", "Tap"]
    let layouts = (0..<3).filter { nx2ipa_pad_layout_offered(Int32($0)) }.map { layout in
        UIAction(title: names[layout], state: nx2ipa_pad_layout() == Int32(layout) ? .on : .off) { _ in
            nx2ipa_pad_layout_set(Int32(layout))
        }
    }
    func choices(_ title: String, _ labels: [String], selected: Int32,
                 pick: @escaping @MainActor (Int32) -> Void) -> UIMenu {
        UIMenu(title: title, options: .singleSelection, children: labels.enumerated().map { index, label in
            UIAction(title: label, state: selected == Int32(index) ? .on : .off) { _ in pick(Int32(index)) }
        })
    }
    let controls: [UIMenuElement] = [
        UIMenu(title: "Controller layout", options: .singleSelection, children: layouts),
        choices("Control size", ["Small", "Medium", "Large"], selected: nx2ipa_pad_size(), pick: nx2ipa_pad_size_set),
        choices("Left stick", ["Corner", "Higher", "Inward"], selected: nx2ipa_pad_stick(), pick: nx2ipa_pad_stick_set),
        keysThatToggle(),
        UIAction(title: "Touch feedback", state: nx2ipa_pad_feedback() ? .on : .off) { _ in
            nx2ipa_pad_feedback_set(!nx2ipa_pad_feedback())
        }
    ]
    let quit = UIAction(title: "Quit game", image: UIImage(systemName: "xmark.circle"), attributes: .destructive) { _ in
        confirmQuit()
    }
    return [UIMenu(options: .displayInline, children: controls), UIMenu(options: .displayInline, children: [quit])]
}

// NX2Apple's DM_PAD_C_* key identifiers, retained with its geometry and toggle rules.
private let toggleKeys: [(control: Int32, name: String)] = [
    (1, "A"), (2, "B"), (3, "X"), (4, "Y"), (8, "L"), (10, "R"), (7, "ZL"), (9, "ZR"),
    (11, "L3"), (12, "R3"), (13, "−"), (14, "+")
]

@MainActor
private func keysThatToggle() -> UIMenuElement {
    let on = toggleKeys.filter { nx2ipa_pad_toggles($0.control) }.map(\.name)
    let keys = toggleKeys.map { key in
        UIAction(title: key.name, state: nx2ipa_pad_toggles(key.control) ? .on : .off) { _ in
            nx2ipa_pad_toggle_set(key.control, !nx2ipa_pad_toggles(key.control))
        }
    }
    return UIMenu(title: "Keys that toggle", subtitle: on.isEmpty ? "None" : on.joined(separator: " "), children: keys)
}

@MainActor
private func confirmQuit() {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
        .first(where: { $0.activationState == .foregroundActive }),
          let controller = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { return }
    guard !(controller.presentedViewController is UIAlertController) else { return }
    nx2ipa_overlay_reset()
    let alert = UIAlertController(title: "Quit game?", message: "Unsaved progress may be lost. Relaunch the app to play again.", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    alert.addAction(UIAlertAction(title: "Quit", style: .destructive) { _ in
        nx2ipa_overlay_active(false)
        let closing = UILabel(frame: controller.view.bounds)
        closing.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        closing.backgroundColor = .black
        closing.textColor = .white
        closing.textAlignment = .center
        closing.text = "Closing game…"
        controller.view.addSubview(closing)
        nx2ipa_stop()
    })
    let present = {
        guard scene.activationState == .foregroundActive, controller.presentedViewController == nil else { return }
        controller.present(alert, animated: true)
    }
    // A UIMenu can still own a presentation while its action runs. Finish that
    // dismissal before presenting, rather than dropping the Quit request.
    if controller.presentedViewController != nil { controller.dismiss(animated: true, completion: present) }
    else { present() }
}
