"use client";

// Top of the start screen, only until the app is on the home screen (lib/install.ts). Nothing opens or
// speaks by itself: a popup confuses VoiceOver/TalkBack users.
//   Android Chrome: "Апп болгож суулгах" opens Chrome's own install dialog.
//   iPhone: "Хэрхэн суулгах вэ" says the steps in the app's voice and shows them under the button.
//   The steps are not a live region (VoiceOver would talk over the app's voice): swipe to read them.
import { useState, useSyncExternalStore } from "react";
import { installState, openInstallDialog, serverInstallState, subscribeInstall } from "../lib/install";
import { IOS_INSTALL_STEPS } from "../lib/installSteps";
import { say, unlockAudio } from "../lib/speech";

const IOS_STEPS = IOS_INSTALL_STEPS; // TODO(wording) in lib/installSteps.ts; hidden while empty

export default function InstallButton() {
  const state = useSyncExternalStore(subscribeInstall, installState, serverInstallState);
  const [stepsShown, setStepsShown] = useState(false);

  if (state === "android") {
    return (
      <button
        type="button"
        className="install-button"
        onClick={function () {
          openInstallDialog();
        }}
      >
        Апп болгож суулгах
      </button>
    );
  }

  if (state === "ios" && IOS_STEPS.length) {
    return (
      <div className="install-help">
        <button
          type="button"
          className="install-button"
          aria-expanded={stepsShown}
          aria-controls="install-steps"
          onClick={function () {
            unlockAudio(); // inside the tap, or iPhones stay silent
            setStepsShown(true);
            say(IOS_STEPS);
          }}
        >
          Хэрхэн суулгах вэ
        </button>
        {stepsShown && (
          <ol id="install-steps" className="install-steps">
            {IOS_STEPS.map(function (item) {
              return <li key={item}>{item}</li>;
            })}
          </ol>
        )}
      </div>
    );
  }

  return null; // installed, or nothing to offer
}
