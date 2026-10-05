/**
 * A headless Chrome session over the DevTools protocol, shared by every suite.
 *
 * WHY THIS EXISTS
 *
 * Eight end-to-end suites each carried their own copy of the same hundred-odd
 * lines: spawn Chrome, poll for the debug endpoint, open a WebSocket, wrap
 * `send`, `evaluate`, `goto`, `shot`. That is a maintenance cost, but the reason
 * it was worth extracting is a BUG those copies shared.
 *
 * Every suite guessed a port from a HARD-CODED RANGE — 9800, 9860, 9900, 9940,
 * 9950, 9980 — plus a random offset. Run the suites one after another and the
 * ranges overlap, so the second suite can pick a port the first one still holds.
 * Chrome then fails to start and the suite dies with `could not attach to
 * Chrome`, which looks like the STORE being broken. That happened: four suites
 * reported failure in a single chained run and every one of them passed when run
 * alone.
 *
 * A port is now allocated by asking the operating system for a free one, and the
 * whole launch is retried if Chrome still cannot be reached. Nothing guesses.
 *
 * WHAT IT GIVES BACK
 *
 *   session.evaluate(expression)      run JS in the page, get the value
 *   session.goto(url, settleMs)       navigate and wait for it to settle
 *   session.waitFor(selector)         wait for an element to exist
 *   session.click(selector)           click, reporting whether it was there
 *   session.fill(selector, value)     set a controlled input the way typing does
 *   session.shot(name)                write a screenshot
 *   session.consoleErrors             console errors seen so far
 *   session.close()                   always call this: it stops Chrome
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask the OS for a port nothing is using, then release it for Chrome. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Poll the debug endpoint until a page target appears, or give up. */
async function waitForTarget(port, attempts) {
  for (let i = 0; i < attempts; i += 1) {
    await sleep(250);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await response.json();
      const target = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
      if (target) return target;
    } catch {
      // Not listening yet.
    }
  }
  return null;
}

/**
 * Start a session.
 *
 * `label` names the temporary profile, so a leaked one can be traced to the suite
 * that made it. `shots` is the directory screenshots go to; it is created here.
 */
export async function startBrowser({ label = 'e2e', shots = null, windowSize = '1440,1100', attempts = 4 } = {}) {
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}`);
  }
  if (shots) fs.mkdirSync(shots, { recursive: true });

  let lastError = 'could not attach to Chrome';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await freePort();
    const profile = `/tmp/cdp-${label}-${port}`;
    const chrome = spawn(
      CHROME,
      [
        '--headless=old',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        `--window-size=${windowSize}`,
        'about:blank',
      ],
      { stdio: 'ignore' }
    );

    let exited = false;
    chrome.on('exit', () => {
      exited = true;
    });

    const target = await waitForTarget(port, 40);
    if (!target) {
      lastError = exited ? `Chrome exited on port ${port}` : `Chrome never answered on port ${port}`;
      chrome.kill();
      fs.rmSync(profile, { recursive: true, force: true });
      await sleep(500);
      continue;
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const opened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(true);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (!opened) {
      lastError = `WebSocket to Chrome failed on port ${port}`;
      chrome.kill();
      fs.rmSync(profile, { recursive: true, force: true });
      await sleep(500);
      continue;
    }

    // ------------------------------------------------------------ protocol
    let messageId = 0;
    const pending = new Map();
    const consoleErrors = [];
    /**
     * Top-level navigations, in order, and the URL the page is on now.
     *
     * A suite that follows a redirect chain — the identity provider hands the
     * browser to the client, which hands it back — needs to see WHERE it went,
     * not only what the final document contains. Reading `location.href` after
     * the fact cannot show the order of the hops.
     */
    const navigations = [];
    let currentUrl = 'about:blank';

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
      if (
        message.method === 'Runtime.consoleAPICalled' &&
        message.params?.type === 'error'
      ) {
        consoleErrors.push(
          (message.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
        );
      }
      if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
        currentUrl = message.params.frame.url;
        navigations.push(currentUrl);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(
          message.params?.exceptionDetails?.exception?.description ??
            message.params?.exceptionDetails?.text ??
            'uncaught exception'
        );
      }
    });

    /**
     * Send a protocol command and wait for its reply.
     *
     * EVERY command needs a timeout, because a dropped reply would otherwise hang
     * the suite until the harness killed it — and a hang reports nothing.
     *
     * The timeout is generous and per-command. `Page.navigate` acknowledges a
     * navigation rather than waiting for it, so it should answer in milliseconds;
     * 30 seconds is already two orders of magnitude of slack. `Runtime.evaluate`
     * can legitimately take longer, because the page's own promise is awaited
     * inside it.
     */
    const send = (method, params, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        const id = ++messageId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(`CDP ${method}: ${message.error.message}`));
          else resolve(message);
        });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(`${method} could not be sent`));
        }
      });

    const evaluate = async (expression) => {
      const response = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (response?.result?.exceptionDetails) {
        throw new Error(response.result.exceptionDetails.text ?? 'evaluation failed');
      }
      return response?.result?.result?.value;
    };

    const goto = async (url, settle = 1200) => {
      await send('Page.navigate', { url });
      for (let i = 0; i < 80; i += 1) {
        await sleep(250);
        try {
          if (await evaluate("document.readyState === 'complete'")) break;
        } catch {
          // Navigation can interrupt an evaluation; keep waiting.
        }
      }
      await sleep(settle);
    };

    const waitFor = async (selector, attempts = 60) => {
      for (let i = 0; i < attempts; i += 1) {
        if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
        await sleep(400);
      }
      return false;
    };

    /**
     * An expression that clicks an element and reports whether it was there.
     *
     * RETURNS A STRING, NOT A PROMISE, and that is deliberate. The suites were
     * written to compose these into a single round trip:
     *
     *     await evaluate(click('[data-testid="save"]'))
     *
     * A helper that evaluated internally turned that into `evaluate(<Promise>)`,
     * which the page receives as `undefined` — so the click never happened and
     * the suite believed it had. Three suites lost most of their checks to that
     * before it was noticed, which is why the contract is spelled out here.
     */
    const click = (selector) => `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`;

    /**
     * An expression that sets a controlled field the way typing does.
     *
     * Also a STRING, for the same reason as `click` above — the suites call
     * `evaluate(fill(...))`.
     *
     * Assigning `.value` directly does not work: React tracks the previous value
     * on the node and skips its own handler. The native setter is what makes the
     * change visible to the component. `select` and `textarea` need their own
     * prototype, or the setter throws on the wrong element type.
     */
    const fill = (selector, value) => `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
        : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;

    const shot = async (name) => {
      if (!shots) return;
      const response = await send('Page.captureScreenshot', { format: 'png' });
      if (response?.result?.data) {
        fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(response.result.data, 'base64'));
      }
    };

    /**
     * Remove the temporary profile.
     *
     * Chrome does not release it the instant it is signalled, so a synchronous
     * delete can throw `ENOTEMPTY` — which would crash a suite that had already
     * finished and PASSED. That happened. The removal is therefore best effort
     * with a short retry, and a failure is reported rather than thrown: a
     * leftover directory in /tmp must never fail a test run.
     */
    const removeProfile = async () => {
      for (let i = 0; i < 5; i += 1) {
        try {
          fs.rmSync(profile, { recursive: true, force: true });
          return;
        } catch {
          await sleep(300);
        }
      }
      console.error(`[browser] could not remove the temporary profile ${profile}`);
    };

    const close = async () => {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      chrome.kill();
      await removeProfile();
    };

    await send('Page.enable');
    await send('Runtime.enable');

    /**
     * Prove the session actually works BEFORE handing it over.
     *
     * Chrome can accept a WebSocket and then fail to render anything — which is
     * what happens when a previous Chrome has not finished releasing the machine
     * and the new one starts under load. The session looks healthy, every
     * `querySelector` returns null, and the suite reports element after element
     * as missing. That is how a store that works perfectly reads as broken.
     *
     * So the session renders a trivial data URL and reads a value back out of it.
     * If that fails, this launch is abandoned and the loop starts another Chrome
     * instead of handing a dead session to the suite.
     */
    let alive = false;
    try {
      await goto('data:text/html,<title>probe</title><div id=p>ready</div>', 200);
      alive = (await evaluate("document.getElementById('p')?.textContent ?? ''")) === 'ready';
    } catch {
      alive = false;
    }

    if (!alive) {
      lastError = `Chrome answered on port ${port} but could not render a probe page`;
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      chrome.kill();
      await removeProfile();
      await sleep(700);
      continue;
    }

    return {
      port,
      evaluate,
      goto,
      waitFor,
      click,
      fill,
      shot,
      close,
      consoleErrors,
      send,
      navigations,
      url: () => currentUrl,
    };
  }

  throw new Error(`${lastError} (tried ${attempts} ports)`);
}

/** A tiny reporting helper, so every suite prints the same shape. */
export function createReporter() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };
  const report = () => {
    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
    return failed.length;
  };
  return { check, report, results };
}
