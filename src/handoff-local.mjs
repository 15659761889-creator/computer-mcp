import { aiBrowserHandoff, aiBrowserRunning, browserInstalled, isAiBrowserHandle } from './browser.mjs';
import { callDesktop, desktopSupported } from './desktop.mjs';

// The phone's browser takeover on this computer: Windows browser windows through desktop control,
// and the AI's own headless browser (negative handles) through Playwright.
const desktop = (method, args) => callDesktop(method, args).catch((err) => ({ text: err.message, isError: true }));

export async function localHandoff(method, args = {}) {
  if (method === 'handoff_list') {
    // Without a desktop the AI's browser is the only one, so it is started for the person to see.
    const ai = await aiBrowserHandoff('handoff_list', { launch: !desktopSupported });
    if (!desktopSupported) {
      if (!ai.isError && !ai.windows.length && !browserInstalled()) return { text: 'the AI browser is not installed on this computer; run wanji browser', isError: true };
      return ai;
    }
    const windows = await desktop('handoff_list', {});
    if (windows.isError && ai.isError) return windows;
    return { text: 'browser windows', windows: [...(ai.windows || []), ...(windows.windows || [])] };
  }
  if (method === 'handoff_start') {
    // The AI asked for help: with its own browser when it has been using that one.
    if (!desktopSupported || aiBrowserRunning()) {
      if (!browserInstalled()) return { text: desktopSupported ? 'Open Chrome, Edge or Firefox' : 'the AI browser is not installed on this computer; run wanji browser', isError: true };
      return aiBrowserHandoff('handoff_start', {});
    }
    return desktop(method, args);
  }
  if (isAiBrowserHandle(args.hwnd) || !desktopSupported) return aiBrowserHandoff(method, args);
  return desktop(method, args);
}
