// iPhone install steps, spoken by the "Хэрхэн суулгах вэ" button (components/InstallButton.tsx).
// TODO(wording, team): write the steps in Mongolian, one short sentence each, in order:
//   1. the Share button (bottom of Safari)  2. "Add to Home Screen"  3. "Add".
// Then add them to shared/phrases.json and make their clips (server: make_speech.py --fixed) so they
// play in the Mongolian voice, never the phone's own. Until filled, the iPhone button stays hidden
// (a button that says nothing would confuse a VoiceOver user).
export const IOS_INSTALL_STEPS: string[] = [];
