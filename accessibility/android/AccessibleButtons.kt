package accessibility

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat

/**
 * One action the rider can take. TalkBack reads [label], then [hint].
 * A double tap is delivered as [AccessibilityNodeInfoCompat.ACTION_CLICK], not as two clicks.
 */
class AccessibleAction(
    val label: String,
    val hint: String,
    val perform: () -> Unit,
)

/**
 * A button with an explicit spoken name and hint. TalkBack's double tap is handled here.
 *
 * TalkBack consumes touch gestures. Do not look for two taps in an onTouch listener while it
 * is on: the second tap never reaches the view as a normal click sequence. It arrives as
 * ACTION_CLICK on this delegate. Returning true means the button handled it.
 */
class AccessibleActionButton(
    context: android.content.Context,
    private val action: AccessibleAction,
) : Button(context) {

    init {
        text = action.label
        // The visible text is already the label. contentDescription replaces it when set,
        // so keep them the same and put the extra sentence in the hint.
        contentDescription = action.label
        ViewCompat.setAccessibilityDelegate(this, object : AccessibilityDelegateCompat() {
            override fun onInitializeAccessibilityNodeInfo(
                host: View,
                info: AccessibilityNodeInfoCompat,
            ) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.className = Button::class.java.name
                info.contentDescription = action.label
                // Spoken after the label. TalkBack adds "button" from the class name.
                info.hintText = action.hint
                info.isClickable = true
                info.addAction(AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_CLICK)
            }

            override fun performAccessibilityAction(host: View, actionId: Int, args: Bundle?): Boolean {
                if (actionId == AccessibilityNodeInfoCompat.ACTION_CLICK) {
                    action.perform()
                    return true
                }
                return super.performAccessibilityAction(host, actionId, args)
            }
        })
        // TalkBack off: a single tap. Same work as the double tap above.
        setOnClickListener { action.perform() }
    }
}

/**
 * Shows the buttons and, once they are on screen, asks TalkBack to read every label.
 */
class AccessibleButtonGroup(
    context: android.content.Context,
    private val actions: List<AccessibleAction>,
) : LinearLayout(context) {

    init {
        orientation = VERTICAL
        for (action in actions) {
            addView(AccessibleActionButton(context, action), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        }
        addView(
            AccessibleActionButton(
                context,
                AccessibleAction("Hear the screen again", "Double tap to hear every button.") {
                    announceEveryButton()
                },
            ),
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT),
        )
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        // The window must be attached before TalkBack will speak an announcement.
        post { announceEveryButton() }
    }

    /** One sentence, in order, so the rider hears the whole set without swiping first. */
    fun announceEveryButton() {
        if (actions.isEmpty()) {
            return
        }
        val names = actions.mapIndexed { index, action -> "${index + 1}. ${action.label}" }
        val sentence = "${actions.size + 1} buttons. " + names.joinToString(". ") + ". ${actions.size + 1}. Hear the screen again."
        announceForAccessibility(sentence)
    }
}
