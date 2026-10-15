import UIKit

/// One action the rider can take. VoiceOver reads `label`, then `hint`, and a double tap
/// calls `perform` through `accessibilityActivate()` — not through a second touch event.
struct AccessibleAction {
    let label: String
    let hint: String
    let perform: () -> Void
}

/// A button whose spoken name and hint are set explicitly, and whose VoiceOver double tap
/// is handled in code.
///
/// VoiceOver owns the screen's gestures. A double tap does not arrive as two `touchUpInside`
/// events. It arrives as `accessibilityActivate()`. Returning `true` means this button
/// handled it, so VoiceOver does not also try the default action.
final class AccessibleActionButton: UIButton {
    private let action: AccessibleAction

    init(action: AccessibleAction) {
        self.action = action
        super.init(frame: .zero)
        setTitle(action.label, for: .normal)
        // Spoken instead of the visible title when they differ. Here they match.
        accessibilityLabel = action.label
        // Spoken after the label, following a short pause. Do not repeat "button";
        // VoiceOver already adds the trait.
        accessibilityHint = action.hint
        accessibilityTraits = .button
        addTarget(self, action: #selector(touchActivate), for: .touchUpInside)
    }

    required init?(coder: NSCoder) {
        return nil
    }

    /// VoiceOver double tap.
    override func accessibilityActivate() -> Bool {
        action.perform()
        return true
    }

    /// A finger tap while VoiceOver is off. Same work as the double tap above.
    @objc private func touchActivate() {
        action.perform()
    }
}

/// Lays the buttons out and, once they are on screen, asks VoiceOver to read every one.
final class AccessibleButtonScreen: UIViewController {
    private let actions: [AccessibleAction]
    private var buttons: [AccessibleActionButton] = []

    init(actions: [AccessibleAction]) {
        self.actions = actions
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
        ])
        for action in actions {
            let button = AccessibleActionButton(action: action)
            button.heightAnchor.constraint(equalToConstant: 72).isActive = true
            buttons.append(button)
            stack.addArrangedSubview(button)
        }
        let again = AccessibleActionButton(action: AccessibleAction(
            label: "Hear the screen again",
            hint: "Double tap to hear the heading and every button.",
            perform: { [weak self] in self?.announceEveryButton() }
        ))
        again.heightAnchor.constraint(equalToConstant: 72).isActive = true
        buttons.append(again)
        stack.addArrangedSubview(again)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        announceEveryButton()
    }

    /// One announcement, in order, so the rider hears the whole set without swiping first.
    /// Posted after the buttons exist. `.announcement` is spoken even when focus stays put.
    func announceEveryButton() {
        guard UIAccessibility.isVoiceOverRunning, !buttons.isEmpty else {
            return
        }
        let names = buttons.enumerated().map { index, button in
            "\(index + 1). \(button.accessibilityLabel ?? "")"
        }
        let sentence = "\(buttons.count) buttons. " + names.joined(separator: ". ") + "."
        UIAccessibility.post(notification: .announcement, argument: sentence)
    }
}
