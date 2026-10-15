// The family member SOS reaches: one phone number, saved on this phone (set once by a sighted helper,
// or ?family=99112233 for demos). SOS opens the phone's own SMS app / dialer: free, works everywhere.

const KEY = "avtobus.family";

// "99112233" -> "+97699112233" (Mongolian 8-digit numbers); other formats kept as digits with "+".
export function normalizeNumber(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 8) {
    return "+976" + digits;
  }
  return digits ? "+" + digits : "";
}

export function familyNumber(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("family");
  if (fromUrl) {
    return normalizeNumber(fromUrl);
  }
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveFamilyNumber(raw: string): string {
  const number = normalizeNumber(raw);
  try {
    if (number) {
      window.localStorage.setItem(KEY, number);
    } else {
      window.localStorage.removeItem(KEY);
    }
  } catch {
    // storage blocked: the number lasts until the page closes
  }
  return number;
}

export function sosMessage(lat: number, lon: number, where: string): string {
  return "Тусламж хэрэгтэй байна! " + (where ? where + " " : "") + "Байршил: https://maps.google.com/?q=" + lat.toFixed(6) + "," + lon.toFixed(6);
}

// Android opens sms:NUMBER?body= . iPhone opens sms:NUMBER&body= and drops the message if a "?" is there.
export function smsUrl(number: string, body: string): string {
  const text = encodeURIComponent(body);
  const ios = typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
  return "sms:" + number + (ios ? "&body=" : "?body=") + text;
}

export function telUrl(number: string): string {
  return "tel:" + number;
}

// Must run inside a tap: phones only open the SMS app / dialer from a user gesture.
export function openLink(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
