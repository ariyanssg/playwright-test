import { chromium, type Browser } from 'playwright';

/**
 * A single headless Chromium shared by discovery, scanning, and the hours pass.
 *
 * Each phase used to launch and tear down its own browser, which costs a few hundred
 * milliseconds every time and repeats once per site during a crawl. Callers take a
 * reference instead; the browser closes when the last one is returned.
 */
let shared: Promise<Browser> | null = null;
let holders = 0;

export async function acquireBrowser(): Promise<Browser> {
  holders += 1;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    shared ??= chromium.launch({ headless: true });
    try {
      const browser = await shared;
      if (browser.isConnected()) return browser;
    } catch (error) {
      shared = null;
      holders -= 1;
      throw error;
    }
    // A browser that died under a previous holder must not be handed out again.
    shared = null;
  }
  holders -= 1;
  throw new Error('Could not start a headless browser');
}

export async function releaseBrowser(): Promise<void> {
  holders = Math.max(0, holders - 1);
  await closeIfIdle();
}

/**
 * Keeps the browser alive across a group of phases so back-to-back work reuses one process.
 * The returned function is safe to call more than once.
 */
export function holdBrowser(): () => Promise<void> {
  holders += 1;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    await closeIfIdle();
  };
}

async function closeIfIdle(): Promise<void> {
  if (holders > 0 || !shared) return;
  const pending = shared;
  shared = null;
  await pending.then((browser) => browser.close()).catch(() => undefined);
}
