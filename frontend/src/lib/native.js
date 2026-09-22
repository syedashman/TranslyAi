// Capacitor-native-only wiring (Android app chrome, hardware back button, external links). Every function here
// no-ops on the web: Capacitor.isNativePlatform() is false in a normal browser, so none of this affects the
// existing Netlify deployment - it only runs inside the packaged Android app.
import { Capacitor } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();

// Keeps the Android status bar's icon color and background in sync with the app's own dark/light theme toggle,
// instead of leaving it fixed to whichever theme happened to be active at build time.
export async function syncStatusBar(theme) {
  if (!isNative) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setBackgroundColor({ color: theme === 'light' ? '#ffffff' : '#18181b' });
    await StatusBar.setStyle({ style: theme === 'light' ? Style.Dark : Style.Light });
  } catch { /* cosmetic only - never block the app over it */ }
}

// Hides the native splash screen once the UI has actually mounted and painted, rather than a fixed timer that
// could either race the real content or linger after it's ready.
export async function hideSplash() {
  if (!isNative) return;
  try { const { SplashScreen } = await import('@capacitor/splash-screen'); await SplashScreen.hide(); }
  catch { /* if the plugin isn't available for some reason, the configured launchShowDuration still hides it */ }
}

// Hardware/system back button: goes back through the app's own navigation history (which is exactly how the
// existing ?chatId= chat routing already works - see popstateRef in App.jsx) when there is somewhere to go,
// otherwise exits the app instead of leaving the user stuck on a screen with no way back.
export async function wireBackButton() {
  if (!isNative) return;
  try {
    const { App } = await import('@capacitor/app');
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) window.history.back();
      else App.exitApp();
    });
  } catch { /* no native back-button integration available; the on-screen UI still works normally */ }
}

// Opens external links (e.g. the Share dialog's X/LinkedIn/Reddit buttons) in the system browser/Custom Tabs
// instead of inside the app's own WebView, where there'd be no address bar or way back to a third-party site.
export async function openExternal(url) {
  if (!isNative) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
  try { const { Browser } = await import('@capacitor/browser'); await Browser.open({ url }); }
  catch { window.open(url, '_blank', 'noopener,noreferrer'); }
}
