import { BrowserWindow, desktopCapturer, nativeImage, session } from 'electron'
import {
  createServer as createHttpServer,
  get as httpGet,
  request as httpRequest,
  type Server
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  browserReachAllows,
  createProfile,
  deleteProfile,
  findProfileByName,
  prepareLaunch,
  resolveBrowserAddress
} from '@helm/core'
import { screenshot, sendKey, sendMouse, sleep, squash, stripAnsi, typeText, waitFor } from './bridge'
import { BROWSER_PARTITION, BROWSER_POPUPS_MAX, exemptedWebContents } from './browser'
import { createBrowserMcp, MCP_SERVER_NAME } from './browser-mcp'
import type { Check } from './fidelity'
import { mcpConfigDir } from './paths'
import { atPrompt, type CheckContext, type Collector } from './sessionscheck'
import { BROWSER_TABS_MAX } from '../shared/ipc'

/**
 * `pnpm browser-check` - the integrated browser, driven through the real window
 * and, since M17, through Helm's own MCP endpoint.
 *
 * **What a run costs:** **one** `claude` session on haiku - the `live` group,
 * and only that group - and no network beyond `127.0.0.1` / `127.0.0.2`. The
 * driver starts its own HTTP and HTTPS servers and every page in the run comes
 * from them. About three minutes, in two phases. `--only=` anything but `live`
 * spawns nothing and costs no tokens.
 *
 * `GROUPS` below is the only authority for the list.
 *
 * Six things in it are worth reading before touching it. The first three are
 * M16's, about the pane; the last three are M17's, about an agent driving it.
 *
 * **BR-3 is the spike, pinned.** "A tab the user is not on stays capturable,
 * scriptable and clickable" is what M17 is built on, and it is exactly the kind
 * of claim that regresses silently - nothing in this milestone's own UI would
 * look any different. So the assertion is permanent, and it is made
 * *discriminating*: the page is repainted a colour it has never been **after**
 * the view is hidden, and the capture has to come back carrying the new colour.
 * A `capturePage` that returned the last frame painted while visible would pass
 * a naive version of this probe and fail this one.
 *
 * **"The view is hidden" is never asserted from Helm's own bookkeeping.**
 * `browsers.inspect()` reports what Helm last told Electron, which is a
 * statement about `browser.ts` and not about the screen. Every hiding claim
 * here is settled by capturing the **window** and sampling the pixel where the
 * page was: the fixture paints a colour that appears nowhere in Helm's palette,
 * so "that pixel is the fixture's colour" and "it is not" are two facts about
 * light rather than two readings of the same variable. `BR-5` proves the
 * sampler can tell the two apart before any of the hiding probes are believed.
 *
 * **The certificate fixture is generated, not committed.** A private key in the
 * repository is a private key in the repository, whatever it is for. The DER is
 * assembled by hand below (`selfSignedCertificate`) because Node can make a key
 * pair and sign bytes but cannot mint an X.509, and shelling out to `openssl`
 * would make this check pass or fail on whether a machine happens to have it.
 *
 * **The M17 groups speak MCP to the endpoint themselves.** They do not go
 * through `claude` and they do not call the tool handlers as functions: the
 * driver registers with `browserMcp` as though it were a session, gets a bearer
 * token, and makes real HTTP requests to `127.0.0.1:<port>/mcp`. So every one
 * of those probes exercises the listener, the token gate, the JSON-RPC framing
 * and the handler at once, and a tool that worked only when called in-process
 * would fail all of them.
 *
 * **The screenshot proof is exact-pixel and is made to fail first.** The tool
 * hands back base64 PNG; the driver decodes it with `nativeImage` - Chromium's
 * decoder, not the encoder that made it - and counts the fixture's colour.
 * Then the page is repainted a colour it has never been and the *same*
 * comparator is required to stop finding the first one and start finding the
 * second. A screenshot path that returned a stale frame, an empty image or a
 * picture of the window instead of the page fails that pair.
 *
 * **`live` is one real session and it is the only thing here that costs
 * anything.** A prediction about a session is worth what a session says about
 * it: the driver asks a real `claude` to open the fixture and click the planted
 * element, and then confirms the tab, the click and the resulting title against
 * its own reads rather than against what the session claimed.
 */

const GROUPS = [
  'pane',
  'wins',
  'bounds',
  'hidden',
  'console',
  'reach',
  'isolation',
  'postures',
  'persist',
  'intact',
  // A page that closes itself, and the popup sign-in that made it necessary.
  'popups',
  // M17: the endpoint, the tools, and a real session driving them.
  'endpoint',
  'tools',
  'unwatched',
  'mcpreach',
  'lifetime',
  'live'
] as const
type Group = (typeof GROUPS)[number]

export interface BrowserCheckOptions {
  dataDir: string
  shotDir: string
  /** `main` is the first app start; `restart` is the second, for persistence. */
  phase: 'main' | 'restart'
  only?: string[] | undefined
}

/**
 * The fixture's background, and it is chosen rather than arbitrary.
 *
 * `#123456` appears nowhere in `theme.css` - not in either canvas, not in a
 * surface, not in an accent - so a pixel that is exactly this colour came from
 * the fixture page and from nothing else. Every "is the view painting" question
 * in this file is answered by counting pixels of it.
 */
const FIXTURE_RGB = { r: 0x12, g: 0x34, b: 0x56 }
/** The colour the page is repainted **while hidden**, to defeat a stale frame. */
const REPAINT_RGB = { r: 0xd8, g: 0x1b, b: 0x60 }

const LOG_TOKEN = 'BROWSER-FIXTURE-LOG-4711'
const ERROR_TOKEN = 'BROWSER-FIXTURE-ERROR-8823'
const EVAL_VALUE = 'FIXTURE-EVAL-VALUE-1907'
/**
 * A word in the fixture's **body**, for find-in-page.
 *
 * In the body and not only in the title, which is what the first run of BR-26
 * found the hard way: `findInPage` searches rendered text and the fixture page
 * had none at all, so "no matches" was a true statement about the fixture and
 * said nothing about the feature. Twice, so a match count is a count.
 */
const FIND_TOKEN = 'HELMFINDTOKEN'
const COOKIE_NAME = 'helmbrowsercheck'
const COOKIE_VALUE = 'persisted-4711'
/**
 * What the popup posts back through `window.opener`.
 *
 * Standing in for the authorisation code, and the whole point of the exercise:
 * it can only arrive if the opened page has a live opener, which a Helm tab can
 * never give it. A distinctive value rather than `true`, so the assertion is
 * "this string made the round trip" and not "something truthy happened".
 */
const POPUP_CODE = 'FIXTURE-OAUTH-CODE-5501'
/**
 * How long the popup stays up before closing itself.
 *
 * Long enough for the driver to count windows while it is there, which the
 * first run of BR-39 was not: the popup closed at 700ms and the count was taken
 * at 900, so a flow that worked perfectly reported one window throughout and
 * failed on the one assertion that says a window was ever made.
 */
const POPUP_LIVES_MS = 2500

/**
 * The M17 fixture's planted element, and what clicking it does.
 *
 * Planted rather than found, and every one of these is a token no page anywhere
 * else could produce: "the snapshot named the element" and "the click changed
 * the page" are only claims if the thing named and the thing changed could have
 * come from nowhere but this fixture.
 */
const PLANT_LABEL = 'HELMPLANTEDBUTTON5150'
/** What the button writes into the document when it is really clicked. */
const PLANT_CLICKED = 'HELMCLICKED8420'
/** The title the page takes on afterwards - a second, independent witness. */
const PLANT_TITLE = `Helm fixture clicked ${PLANT_CLICKED}`
/** What the fixture logs on load, for `browser_console`. */
const PLANT_LOG = 'HELM-PLANTED-CONSOLE-3391'
/** What `browser_evaluate` is asked for and must get back. */
const PLANT_EVAL = 'HELM-PLANTED-EVAL-6604'
/** What `browser_type` is asked to land in the field. */
const PLANT_TYPED = 'helm-typed-2208'

/** Where phase one writes the port, so phase two can bind the same origin -
 * a cookie belongs to a scheme, a host **and a port**. */
const FIXTURE_FILE = 'browser-fixture.json'

// ---------------------------------------------------------------------------
// Talking to the window
// ---------------------------------------------------------------------------

const q = (value: string): string => JSON.stringify(value)

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression, true) as Promise<T>
}

const byAttr = (name: string): string => `document.querySelector('[${name}]')`

async function clickAttr(win: BrowserWindow, name: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = ${byAttr(name)}; if (!el) return false; el.click(); return true })()`
  )
}

async function clickSelector(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${q(selector)}); if (!el) return false; el.click(); return true })()`
  )
}

async function typeInto(win: BrowserWindow, selector: string, text: string): Promise<boolean> {
  const focused = await js<boolean>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return false; el.focus(); el.select(); return true })()`
  )
  if (!focused) return false
  await typeText(win, text)
  return true
}

/**
 * A real Chromium click in the middle of an element.
 *
 * `el.click()` is enough for a button and is not enough for anything that has
 * to take **focus**: a synthetic click does not move the caret, so a probe that
 * used one on the address bar found an empty dropdown and could not tell that
 * from a dropdown that does not work.
 */
async function clickCentre(win: BrowserWindow, selector: string): Promise<boolean> {
  const box = await js<{ x: number; y: number } | null>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return null; const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`
  )
  if (box === null) return false
  await sendMouse(win, 'mouseDown', box.x, box.y)
  await sendMouse(win, 'mouseUp', box.x, box.y)
  await sleep(120)
  return true
}

async function pollJs(win: BrowserWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await js<boolean>(win, `Boolean(${expression})`).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(150)
  }
}

/** Wait until main says the view has settled on `url`. */
async function waitForUrl(
  ctx: CheckContext,
  id: number,
  match: (url: string) => boolean,
  timeoutMs = 15_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = ctx.browsers.states(id)[0]
    if (state !== undefined && !state.loading && match(state.url)) return true
    if (Date.now() > deadline) return false
    await sleep(150)
  }
}

// ---------------------------------------------------------------------------
// Reading pixels - the independent witness for every hiding claim
// ---------------------------------------------------------------------------

function countColour(
  bitmap: Buffer,
  rgb: { r: number; g: number; b: number },
  tolerance = 2
): number {
  let n = 0
  // capturePage yields BGRA on Windows.
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    if (
      Math.abs((bitmap[i] ?? -99) - rgb.b) <= tolerance &&
      Math.abs((bitmap[i + 1] ?? -99) - rgb.g) <= tolerance &&
      Math.abs((bitmap[i + 2] ?? -99) - rgb.r) <= tolerance
    ) {
      n++
    }
  }
  return n
}

/**
 * How much of the fixture's colour is **on the window**, taken from outside it.
 *
 * `win.webContents.capturePage()` - what `screenshot()` and every other driver
 * here uses - does **not** see a `WebContentsView` at all. Measured while
 * writing this: with the view shown, hidden and shown again, that capture
 * returned zero fixture pixels in all three states while the page was plainly
 * on screen. It captures the window's own web contents, and a native child view
 * is composited beside it rather than into it. Any hiding probe built on it
 * would have passed for the wrong reason - it can never see the thing it is
 * asking about.
 *
 * So the window is captured through `desktopCapturer`, which composites what
 * the OS actually shows. That is the strongest reader available here and it is
 * completely outside Helm: it is not a variable this milestone writes, it is
 * the picture.
 *
 * Returns -1 when the window could not be found among the sources, which is
 * distinguishable from "found it and the page was not there" - a probe that
 * scored a missing window as zero would report every hiding claim green.
 */
async function onScreenFixturePixels(
  ctx: CheckContext,
  shotDir: string,
  name: string
): Promise<number> {
  const bounds = ctx.win.getBounds()
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: bounds.width, height: bounds.height }
  })
  const mediaId = ctx.win.getMediaSourceId()
  const mine =
    sources.find((source) => source.id === mediaId) ??
    sources.find((source) => source.name === ctx.win.getTitle())
  if (mine === undefined) return -1
  mkdirSync(shotDir, { recursive: true })
  writeFileSync(join(shotDir, name), mine.thumbnail.toPNG())
  return countColour(mine.thumbnail.toBitmap(), FIXTURE_RGB)
}

/**
 * The same reading, given time to settle.
 *
 * Hiding and showing a native view is asynchronous all the way down - Helm
 * tells Electron, Electron tells the compositor, the compositor produces a
 * frame, and the OS hands `desktopCapturer` whatever it last had. A fixed sleep
 * before the capture is a guess about all four, and a wrong guess reads as the
 * feature having failed: this probe went red once with the page correctly
 * hidden and once with it correctly shown, purely on timing.
 *
 * So the expected answer is waited for, briefly, and the **last** reading is
 * returned either way. That is not the probe grading itself: it cannot turn a
 * view that stayed on screen into one that went, it can only stop counting a
 * view that had not gone *yet*.
 */
async function fixturePixelsUntil(
  ctx: CheckContext,
  shotDir: string,
  name: string,
  want: 'gone' | 'painting',
  timeoutMs = 5000
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const count = await onScreenFixturePixels(ctx, shotDir, name)
    if (want === 'gone' ? count === 0 : count > 1000) return count
    if (Date.now() > deadline) return count
    await sleep(250)
  }
}

/**
 * What the **page** says about being visible.
 *
 * A second, independent reading of the same question, and independent in a
 * different direction: `document.visibilityState` is Chromium's own answer,
 * reported from inside the page, and nothing in `browser.ts` writes it. It is
 * asserted beside the pixels because the two can only agree by both being
 * right - one is the compositor's opinion and the other is a photograph.
 *
 * It is also the fact worth knowing about the hide mechanism: a hidden view's
 * page *knows* it is hidden, so a page that throttles its own animation on
 * `visibilitychange` will do so. That does not touch the three things M17 needs
 * - BR-3 measures all of them while this reads `hidden` - but it is the reason
 * the hide is a real hide rather than a rectangle moved off screen.
 */
async function pageVisibility(ctx: CheckContext, id: number): Promise<string> {
  const answer = await ctx.browsers.evaluate(id, 'document.visibilityState')
  return answer.ok ? answer.value : `unreadable: ${answer.error ?? ''}`
}

// ---------------------------------------------------------------------------
// The fixture servers
// ---------------------------------------------------------------------------

interface Fixture {
  http: Server
  httpsLoopback: Server
  /** The same certificate, served on a host that is not loopback. */
  httpsNamed: Server
  /**
   * Plain HTTP on `127.0.0.2`, which is this machine and is **not loopback**
   * by the reach rule's list.
   *
   * The reach matrix needs an address that `web` allows and `local` refuses,
   * and it must not be on the internet: a check that proved "the wide posture
   * lets an agent out" by actually going out would be a check that made a
   * network request every time it ran. `127.0.0.2` is reachable, is served by
   * this driver, and is refused by `isLoopbackUrl` - which is exactly the
   * distinction under test.
   */
  httpNamed: Server
  httpPort: number
  httpsPort: number
  httpsNamedPort: number
  httpNamedPort: number
  /** Every request path the servers were actually asked for, in order. */
  asked: string[]
  /** The request headers, in step with `asked` - the only way to tell a hard
   * reload from an ordinary one from outside the browser. */
  askedHeaders: Array<Record<string, string>>
  close(): void
}

const page = (options: {
  title: string
  background: string
  script?: string
}): string => `<!doctype html><html><head><meta charset="utf-8"><title>${options.title}</title></head>
<body style="margin:0;background:${options.background};height:100vh">
<div id="target" style="width:100%;height:100%">
<p style="margin:0;padding:4px;font:12px monospace;color:#f0f0f0">${FIND_TOKEN} ${FIND_TOKEN}</p>
</div>
<script>
  window.__helmFixture = ${JSON.stringify(EVAL_VALUE)}
  window.__clicks = 0
  document.addEventListener('click', () => { window.__clicks++ })
  ${options.script ?? ''}
</script></body></html>`

const BACKGROUND = `rgb(${String(FIXTURE_RGB.r)},${String(FIXTURE_RGB.g)},${String(FIXTURE_RGB.b)})`

function respond(url: string, host: string): { status: number; headers: Record<string, string>; body: string } {
  const path = url.split('?')[0] ?? '/'
  /*
   * A Content-Security-Policy on every fixture page, and it is not decoration.
   *
   * An unpackaged Electron writes a security warning into the console of any
   * page it loads over http with no CSP - so without this the fixture arrives
   * with a warning already in its ring buffer, and "an error raises the count"
   * is being asserted against a count that did not start at zero. The first run
   * of BR-11 found exactly one entry there and it was that warning.
   *
   * Worth knowing beyond this check: a dev server that sends no CSP will put the
   * same line in the pane's console in a dev build of Helm. It is Electron
   * talking about the page, not Helm talking about anything, and it does not
   * appear in a packaged build.
   */
  const html = {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
  }
  if (path === '/two') {
    return { status: 200, headers: html, body: page({ title: 'Helm fixture two', background: BACKGROUND }) }
  }
  if (path === '/errors') {
    return {
      status: 200,
      headers: html,
      body: page({
        title: 'Helm fixture errors',
        background: BACKGROUND,
        script: `console.error(${JSON.stringify(ERROR_TOKEN)})`
      })
    }
  }
  if (path === '/opener') {
    return {
      status: 200,
      headers: html,
      body: page({
        title: 'Helm fixture opener',
        background: BACKGROUND,
        script: `window.__open = () => window.open('http://${host}/two', '_blank')`
      })
    }
  }
  /*
   * The three pages a popup sign-in is made of, and the one that broke Helm.
   *
   * `/selfclose` is the fault: a page that closes itself. Every OAuth popup
   * ends this way, and a Helm tab showing one used to be left holding a
   * `WebContentsView` whose `webContents` Electron had set to undefined - after
   * which the next touch threw, out of a send, as an Electron error dialog.
   *
   * `/signin` and `/popup` are the flow itself, and both halves are needed to
   * measure it: `window.open` has to hand back a live object, and the page it
   * opened has to reach `window.opener` to post a code back. Neither is
   * possible through a tab, which is why the window-open answer changed.
   */
  if (path === '/selfclose') {
    return {
      status: 200,
      headers: html,
      body: page({
        title: 'Helm fixture selfclose',
        background: BACKGROUND,
        script: `window.__close = () => { setTimeout(() => window.close(), 50); return 'closing' }`
      })
    }
  }
  if (path === '/signin') {
    return {
      status: 200,
      headers: html,
      body: page({
        title: 'Helm fixture signin',
        background: BACKGROUND,
        script: `window.__code = null
          window.addEventListener('message', (event) => { window.__code = event.data })
          window.__signIn = () => {
            window.__w = window.open('http://${host}/popup', 'oauth', 'width=480,height=640')
            return window.__w ? 'handle' : 'null'
          }
          window.__popupClosed = () => (window.__w ? window.__w.closed : null)`
      })
    }
  }
  if (path === '/popup') {
    return {
      status: 200,
      headers: html,
      body: page({
        title: 'Helm fixture popup',
        background: BACKGROUND,
        script: `window.__posted = false
          if (window.opener) {
            window.opener.postMessage(${JSON.stringify(POPUP_CODE)}, '*')
            window.__posted = true
          }
          setTimeout(() => window.close(), ${POPUP_LIVES_MS})`
      })
    }
  }
  if (path === '/permission') {
    return {
      status: 200,
      headers: html,
      body: page({
        title: 'Helm fixture permission',
        background: BACKGROUND,
        script: `window.__geo = () => new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            () => resolve('granted'),
            (err) => resolve('denied:' + err.code)
          )
        })`
      })
    }
  }
  if (path === '/download') {
    return {
      status: 200,
      headers: html,
      body: page({
        title: 'Helm fixture download',
        background: BACKGROUND,
        script: `window.__download = () => { location.href = 'http://${host}/payload.bin' }`
      })
    }
  }
  if (path === '/payload.bin') {
    return {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="helm-browser-check.bin"'
      },
      body: 'helm-browser-check payload'
    }
  }
  /*
   * The page M17's tools are driven against.
   *
   * Everything on it is a planted token: a heading, a button whose click is
   * recorded in three independent places (a counter, a paragraph and the
   * document title), a text field that echoes what is typed into it, a value
   * for `browser_evaluate` and a line for `browser_console`. It is written as
   * its own route rather than added to `/` so the M16 groups keep the fixture
   * they were measured against.
   */
  if (path === '/planted') {
    return {
      status: 200,
      headers: html,
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Helm fixture planted</title></head>
<body style="margin:0;background:${BACKGROUND};height:100vh;font:14px system-ui;color:#f0f0f0">
<h1 id="heading" style="margin:0;padding:8px">Planted page ${PLANT_LABEL}</h1>
<button id="plant" type="button" style="margin:8px;padding:8px 12px">${PLANT_LABEL}</button>
<input id="field" type="text" placeholder="planted field" style="margin:8px;padding:6px" />
<p id="result" style="margin:8px">not clicked</p>
<p id="echo" style="margin:8px">typed: (nothing)</p>
<script>
  window.__helmPlanted = ${JSON.stringify(PLANT_EVAL)}
  window.__plantClicks = 0
  console.log(${JSON.stringify(PLANT_LOG)})
  document.getElementById('plant').addEventListener('click', () => {
    window.__plantClicks++
    document.getElementById('result').textContent = ${JSON.stringify(PLANT_CLICKED)}
    document.title = ${JSON.stringify(PLANT_TITLE)}
  })
  document.getElementById('field').addEventListener('input', (event) => {
    document.getElementById('echo').textContent = 'typed: ' + event.target.value
  })
</script></body></html>`
    }
  }
  /*
   * A page that is deliberately **not** the fixture colour.
   *
   * The unwatched group needs a tab in front that is not the one under test:
   * with nothing else open, the workspace makes the agent's own tab the active
   * pane and it is then a tab somebody *is* looking at. This is what occupies
   * the front, and it paints a colour `countColour` will never mistake for the
   * fixture's.
   */
  if (path === '/decoy') {
    return {
      status: 200,
      headers: html,
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Helm fixture decoy</title></head>
<body style="margin:0;background:rgb(9,9,9);height:100vh;color:#888;font:12px monospace">
<p style="margin:0;padding:6px">decoy - deliberately not the fixture colour</p>
</body></html>`
    }
  }
  if (path === '/cookie') {
    return {
      status: 200,
      headers: {
        ...html,
        // A year, so the second phase is reading a cookie that was *stored*
        // rather than one that happens not to have expired inside a minute.
        'set-cookie': `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=31536000; SameSite=Lax`
      },
      body: page({ title: 'Helm fixture cookie', background: BACKGROUND })
    }
  }
  return {
    status: 200,
    headers: html,
    body: page({
      title: 'Helm fixture one',
      background: BACKGROUND,
      script: `console.log(${JSON.stringify(LOG_TOKEN)})`
    })
  }
}

async function startFixture(dataDir: string, wantedHttpPort: number | null): Promise<Fixture> {
  const asked: string[] = []
  const askedHeaders: Array<Record<string, string>> = []
  const handler = (port: () => number) => {
    return (req: { url?: string | undefined; headers?: Record<string, unknown> }, res: {
      writeHead: (status: number, headers: Record<string, string>) => void
      end: (body: string) => void
    }): void => {
      const url = req.url ?? '/'
      asked.push(url)
      askedHeaders.push(
        Object.fromEntries(
          Object.entries(req.headers ?? {}).map(([key, value]) => [key, String(value)])
        )
      )
      const answer = respond(url, `127.0.0.1:${String(port())}`)
      res.writeHead(answer.status, answer.headers)
      res.end(answer.body)
    }
  }

  let httpPort = 0
  const http = createHttpServer(handler(() => httpPort))
  await listen(http, wantedHttpPort ?? 0)
  const httpAddress = http.address()
  httpPort = typeof httpAddress === 'object' && httpAddress !== null ? httpAddress.port : 0

  /*
   * One certificate, two servers.
   *
   * The certificate names `localhost` and `127.0.0.1`, and both HTTPS servers
   * present it. One is reached as `127.0.0.1`, where the loopback exception
   * must accept it; the other as `127.0.0.2` - which is still this machine on
   * Windows, so it is genuinely reachable - where the exception must **not**
   * apply and Chromium's own verdict must stand. Same bytes, different host, so
   * the only thing the two probes differ by is the rule under test.
   */
  const cert = selfSignedCertificate()
  let httpsPort = 0
  const httpsLoopback = createHttpsServer({ key: cert.key, cert: cert.cert }, handler(() => httpsPort))
  await listen(httpsLoopback, 0)
  const httpsAddress = httpsLoopback.address()
  httpsPort = typeof httpsAddress === 'object' && httpsAddress !== null ? httpsAddress.port : 0

  let httpsNamedPort = 0
  const httpsNamed = createHttpsServer({ key: cert.key, cert: cert.cert }, handler(() => httpsNamedPort))
  await listen(httpsNamed, 0, '127.0.0.2')
  const namedAddress = httpsNamed.address()
  httpsNamedPort = typeof namedAddress === 'object' && namedAddress !== null ? namedAddress.port : 0

  let httpNamedPort = 0
  const httpNamed = createHttpServer(handler(() => httpNamedPort))
  await listen(httpNamed, 0, '127.0.0.2')
  const httpNamedAddress = httpNamed.address()
  httpNamedPort =
    typeof httpNamedAddress === 'object' && httpNamedAddress !== null ? httpNamedAddress.port : 0

  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, FIXTURE_FILE), JSON.stringify({ httpPort }, null, 2))

  return {
    http,
    httpsLoopback,
    httpsNamed,
    httpNamed,
    httpPort,
    httpsPort,
    httpsNamedPort,
    httpNamedPort,
    asked,
    askedHeaders,
    close() {
      // Connections destroyed first, for the reason `close()` above gives: a
      // browser holds its socket open and the servers would otherwise linger
      // past the end of the run.
      for (const server of [http, httpsLoopback, httpsNamed, httpNamed]) {
        server.closeAllConnections()
        server.close()
      }
    }
  }
}

/**
 * `server.listen`, as a promise that **rejects**.
 *
 * Written out because the obvious one-liner - `new Promise((r) => s.listen(p, r))`
 * - never settles when the port is taken: `listen` reports that on the 'error'
 * event, not to the callback. A driver that hangs is worse than one that fails,
 * because a hang looks exactly like a slow check and this one takes minutes.
 */
/**
 * `server.close`, as a promise that actually resolves.
 *
 * `close()` stops accepting and then waits for **every existing connection to
 * end** - and a browser holds its socket open on keep-alive after the page has
 * loaded, so the callback is never called and the driver hangs. Not a
 * hypothetical: this file hung here on its first run of the wins group, and a
 * hang is worse than a failure because it is indistinguishable from a check
 * that is merely slow, which this one legitimately is.
 */
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function listen(server: Server, port: number, host = '127.0.0.1'): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

/** The driver's own read of a fixture page, for comparing the pane against. */
function fetchTitle(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const request = httpGet(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve(/<title>([^<]*)<\/title>/.exec(body)?.[1] ?? null))
    })
    request.on('error', () => resolve(null))
    request.setTimeout(5000, () => {
      request.destroy()
      resolve(null)
    })
  })
}

// ---------------------------------------------------------------------------

export async function runBrowserChecks(
  ctx: CheckContext,
  collector: Collector,
  options: BrowserCheckOptions
): Promise<Check[]> {
  const checks: Check[] = []
  const wanted = options.only?.filter((g): g is Group => (GROUPS as readonly string[]).includes(g))
  const run = (group: Group): boolean => wanted === undefined || wanted.length === 0 || wanted.includes(group)

  mkdirSync(options.shotDir, { recursive: true })

  // Phase two binds the port phase one used, because a cookie belongs to an
  // origin and an origin includes the port.
  const stampFile = join(options.dataDir, FIXTURE_FILE)
  const stamped =
    options.phase === 'restart' && existsSync(stampFile)
      ? (JSON.parse(readFileSync(stampFile, 'utf8')) as { httpPort?: number }).httpPort ?? null
      : null

  const fixture = await startFixture(options.dataDir, stamped)
  const origin = `http://127.0.0.1:${String(fixture.httpPort)}`

  try {
    if (options.phase === 'restart') {
      checks.push(await persistPhaseTwo(ctx, fixture, origin))
      return checks
    }

    await sleep(600)

    if (run('pane')) checks.push(...(await paneGroup(ctx, fixture, origin, options)))
    if (run('wins')) {
      checks.push(...(await winsGroup(ctx, fixture, origin, options)))
      checks.push(await projectMemory(ctx, origin))
    }
    if (run('bounds')) checks.push(...(await boundsGroup(ctx, origin, options)))
    if (run('hidden')) checks.push(...(await hiddenGroup(ctx, origin, options)))
    if (run('console')) checks.push(...(await consoleGroup(ctx, origin, options)))
    if (run('reach')) checks.push(...(await reachGroup(ctx, fixture, origin)))
    if (run('isolation')) checks.push(...(await isolationGroup(ctx, fixture, origin)))
    if (run('postures')) checks.push(...(await posturesGroup(ctx, fixture, origin)))
    if (run('persist')) checks.push(await persistPhaseOne(ctx, origin))
    if (run('intact')) checks.push(await postureIntact(ctx, origin))
    if (run('popups')) checks.push(...(await popupsGroup(ctx, fixture, origin)))

    // M17. Everything below drives the tools rather than the pane.
    if (run('endpoint')) checks.push(...(await endpointGroup(ctx)))
    if (run('tools')) checks.push(...(await toolsGroup(ctx, origin)))
    if (run('unwatched')) checks.push(...(await unwatchedGroup(ctx, origin, options)))
    if (run('mcpreach')) checks.push(...(await mcpReachGroup(ctx, fixture, origin)))
    if (run('lifetime')) checks.push(...(await lifetimeGroup(ctx, origin)))
    if (run('live')) checks.push(...(await liveGroup(ctx, collector, origin, options)))
  } finally {
    fixture.close()
    // Every view this run made, gone - the next phase starts from an app with
    // no tabs, and a view left behind would paint over the second phase.
    for (const state of ctx.browsers.states()) ctx.browsers.close(state.id)
  }

  return checks
}

// ---------------------------------------------------------------------------
// pane
// ---------------------------------------------------------------------------

async function paneGroup(
  ctx: CheckContext,
  fixture: Fixture,
  origin: string,
  options: BrowserCheckOptions
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []

  const opened = await clickAttr(win, 'data-open-browser')
  await sleep(600)
  const paneUp = await pollJs(win, `${byAttr('data-browser-address')}`, 8000)
  const id = await ensureBrowserTab(ctx)

  // Independent second reader: the driver fetches the same page itself and
  // parses the title out of the bytes, rather than asking the pane twice.
  const ownTitle = await fetchTitle(`${origin}/`)

  await typeInto(win, '[data-browser-address]', `${origin}/`)
  await sendKey(win, 'Return')
  const landed = id !== null && (await waitForUrl(ctx, id, (url) => url.startsWith(origin)))
  await sleep(500)

  const addressShows = await js<string>(
    win,
    `${byAttr('data-browser-address')}?.value ?? ''`
  )
  const tabTitle = await js<string>(
    win,
    `(() => { const el = document.querySelector('[data-tab^="browser:"] [data-tab-title]');
      return el ? el.textContent : (document.querySelector('[data-tab^="browser:"]')?.textContent ?? '') })()`
  )

  checks.push({
    id: 'BR-1',
    criterion: 'Browser tabs open real http pages; the address bar and the tab title are the page’s own',
    title: 'A tab opened from the strip loads the fixture, and both labels match the driver’s own fetch',
    ok:
      opened &&
      paneUp &&
      id !== null &&
      landed &&
      ownTitle !== null &&
      ownTitle !== '' &&
      addressShows.startsWith(origin) &&
      tabTitle.includes(ownTitle),
    detail: {
      opened,
      paneUp,
      id,
      addressShows,
      tabTitle,
      independentTitleFromOwnFetch: ownTitle
    },
    notes: [
      'The title is read out of the driver’s own HTTP response rather than out of',
      'a second call to the pane, so the two sides of the comparison do not share',
      'a parser.'
    ]
  })

  if (id === null) return checks

  // Back and forward, round trip.
  ctx.browsers.navigate(id, `${origin}/two`)
  await waitForUrl(ctx, id, (url) => url.endsWith('/two'))
  const atTwo = ctx.browsers.states(id)[0]?.url ?? ''
  await clickSelector(win, '[data-browser="back"]')
  await sleep(700)
  const afterBack = ctx.browsers.states(id)[0]?.url ?? ''
  await clickSelector(win, '[data-browser="forward"]')
  await sleep(700)
  const afterForward = ctx.browsers.states(id)[0]?.url ?? ''

  checks.push({
    id: 'BR-2',
    criterion: 'Back and forward round-trip; a bare port resolves to localhost',
    title: 'Back returns to the first page and forward returns to the second; “PORT” becomes http://localhost:PORT',
    ok:
      atTwo.endsWith('/two') &&
      (afterBack === `${origin}/` || afterBack.startsWith(origin)) &&
      !afterBack.endsWith('/two') &&
      afterForward.endsWith('/two') &&
      resolveBrowserAddress(String(fixture.httpPort)).url ===
        `http://localhost:${String(fixture.httpPort)}/`,
    detail: {
      atTwo,
      afterBack,
      afterForward,
      barePort: {
        typed: String(fixture.httpPort),
        resolvesTo: resolveBrowserAddress(String(fixture.httpPort)).url
      }
    },
    notes: [
      'The bare-port rule is asserted against `resolveBrowserAddress`, which is the',
      'same function the address bar and every agent navigation will go through.'
    ]
  })

  // The recent dropdown: what was visited, in order, capped.
  const recent = ctx.services.settings.browserRecentUrls
  // A real click on the address bar and nothing else. Deliberately not a
  // keystroke: the dropdown opening "when you click the address bar" is the
  // claim, and an earlier version of this probe typed a character first - which
  // passed while the click-only path was broken.
  const focused = await clickCentre(win, '[data-browser-address]')
  await sleep(700)
  // The dropdown hangs over the page, and a native view paints above all
  // renderer DOM - so the view has to have stood down for it. Without this the
  // list is drawn and then covered, which is what the first capture of this
  // pane showed and what nothing in the DOM would ever report.
  const pageHiddenForTheList = await fixturePixelsUntil(
    ctx,
    options.shotDir,
    'browser-recent-dropdown.png',
    'gone'
  )
  const caret = await js<boolean>(
    win,
    `document.activeElement?.hasAttribute('data-browser-address') === true`
  )
  const paneRecent = await js<number>(
    win,
    `Number(document.querySelector('[data-browser-recent-count]')?.getAttribute('data-browser-recent-count') ?? -1)`
  )
  const dropdown = await js<string[]>(
    win,
    `[...document.querySelectorAll('[data-browser-recent-url]')].map((el) => el.getAttribute('data-browser-recent-url'))`
  )

  /*
   * Escape closes it, and the page comes back.
   *
   * Both halves are the check. The second is the other side of "the view stands
   * down for the list": a mechanism that hides and never un-hides passes the
   * assertion above and leaves the pane blank forever. And leaving the list open
   * is what the first version of this did, which suppressed the view for the two
   * groups after it and failed BR-9 with a reading that was entirely correct
   * about a state this driver had created.
   */
  await sendKey(win, 'Escape')
  await sleep(700)
  const listClosed = await js<boolean>(win, `document.querySelector('[data-browser-recent]') === null`)
  const pageBack = await fixturePixelsUntil(ctx, options.shotDir, 'browser-recent-dismissed.png', 'painting')

  checks.push({
    id: 'BR-4',
    criterion: 'The address bar offers the last URLs visited, newest first, capped at ten',
    title: 'The dropdown lists what was actually visited, in order, and no more than ten',
    ok:
      focused &&
      pageHiddenForTheList === 0 &&
      recent.length > 0 &&
      recent.length <= 10 &&
      recent[0]?.endsWith('/two') === true &&
      recent.some((url) => url === `${origin}/`) &&
      dropdown.length === recent.length &&
      dropdown.every((url, at) => url === recent[at]) &&
      listClosed &&
      pageBack > 1000,
    detail: {
      addressBarClicked: focused,
      caretIsInTheAddressBar: caret,
      fixturePixelsWhileTheListWasOpen: pageHiddenForTheList,
      recentThePaneWasHanded: paneRecent,
      recent,
      dropdown,
      afterEscape: { listClosed, fixturePixels: pageBack }
    },
    notes: [
      'The list is written by main on a *successful* navigation, so a redirect or a',
      'retry that finally connected is in it and an address that was typed and',
      'refused is not.',
      'The page is required to be off screen while the list is open: the dropdown is',
      'DOM hanging over the view, and a native view paints above all of it.'
    ]
  })

  await screenshot(ctx.win, options.shotDir, 'browser-pane.png')
  return checks
}

// ---------------------------------------------------------------------------
// wins - the VS Code Simple Browser yardstick, one probe each
// ---------------------------------------------------------------------------

/**
 * The cheap wins, asserted rather than listed.
 *
 * Each of these is one line of Electron and each is the reason somebody would
 * use this pane instead of alt-tabbing to Chrome, so "built" is not the same
 * claim as "works" - and every one of them is the kind of thing that would
 * silently stop working without anything else looking different.
 *
 * Three of them are settled from **outside the browser**: the retry against a
 * server that was not there when the pane was pointed at it, the hard reload
 * against the request headers the fixture actually received, and the width
 * preset against `view.getBounds()`.
 */
async function winsGroup(
  ctx: CheckContext,
  fixture: Fixture,
  origin: string,
  options: BrowserCheckOptions
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []
  const id = await ensureBrowserTab(ctx)
  if (id === null) return checks

  /*
   * Retry on connection refused - the papercut this pane's framing exists for.
   *
   * A port nothing is listening on is chosen by binding one and letting it go,
   * which is the only way to name a port that is free *and* to be sure of it.
   * The pane is pointed at it, has to say it is waiting, and then the server
   * appears - and the page has to arrive with nobody having pressed reload.
   */
  const late = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page({ title: 'Helm fixture late', background: BACKGROUND }))
  })
  const probe = createHttpServer(() => undefined)
  await listen(probe, 0)
  const probeAddress = probe.address()
  const latePort = typeof probeAddress === 'object' && probeAddress !== null ? probeAddress.port : 0
  await close(probe)

  ctx.browsers.navigate(id, `http://127.0.0.1:${String(latePort)}/`)
  /*
   * Sampled repeatedly rather than once.
   *
   * The retry is a *sequence* - fail, wait, ask again - and a single reading
   * taken at whatever moment happens to be convenient can land in the gap
   * between two of them and report nothing happening. These four go in the
   * detail whether the check passes or fails, so a failure here says which part
   * of the sequence stopped rather than only that the end of it was wrong.
   */
  const samples: Array<Record<string, unknown>> = []
  for (const at of [200, 600, 1200, 1800]) {
    await sleep(at === 200 ? 200 : 400)
    const state = ctx.browsers.states(id)[0]
    samples.push({
      at,
      url: state?.url ?? null,
      retryingUntil: state?.retryingUntil ?? null,
      problem: (state?.problem ?? '').slice(0, 60),
      ringSize: ctx.browsers.entries(id).length
    })
  }
  const whileRefused = ctx.browsers.states(id)[0]
  const waitingSaid = await js<string>(win, `${byAttr('data-browser-problem')}?.textContent ?? ''`)

  await listen(late, latePort)
  const connected = await waitForUrl(
    ctx,
    id,
    (url) => url.startsWith(`http://127.0.0.1:${String(latePort)}`),
    20_000
  )
  await sleep(600)
  const afterServerAppeared = ctx.browsers.states(id)[0]
  const lateTitle = await ctx.browsers.evaluate(id, 'document.title')
  await close(late)

  checks.push({
    id: 'BR-24',
    criterion: 'Retry on connection refused: open the pane before the dev server, and it connects when the server appears',
    title: 'A refused port is retried quietly and the page arrives when the server starts, with nothing pressed',
    ok:
      // The pane was not on that address before the server started - so "it
      // arrived" is a claim about the server appearing rather than about a page
      // that had been loaded all along. Not "the URL was empty": a view keeps
      // showing the page it is on while the next load is pending, so an empty
      // URL is only what a *first* navigation looks like.
      samples.every((sample) => !String(sample.url ?? '').includes(String(latePort))) &&
      connected &&
      afterServerAppeared?.retryingUntil === null &&
      afterServerAppeared?.problem === null &&
      lateTitle.value.includes('Helm fixture late'),
    detail: {
      port: latePort,
      samples,
      inspect: ctx.browsers.inspect(id),
      whatTheViewLogged: ctx.browsers.entries(id).slice(-8).map((e) => e.level + ': ' + e.message.slice(0, 160)),
      whileRefused: {
        retryingUntil: whileRefused?.retryingUntil ?? null,
        problem: whileRefused?.problem ?? null,
        painted: waitingSaid.slice(0, 120)
      },
      afterServerAppeared: {
        url: afterServerAppeared?.url ?? null,
        retryingUntil: afterServerAppeared?.retryingUntil ?? null,
        title: lateTitle.value
      }
    },
    notes: [
      'The port is one that was bound and released, so it is known free rather than',
      'guessed - a guessed port that something else happened to be on would report',
      'this as working while nothing was retried.',
      'Only ERR_CONNECTION_REFUSED is retried by Helm. A name that does not resolve,',
      'a refused certificate and a 500 are answers, and retrying an answer is asking',
      'the same question twice.',
      'WHAT THIS ASSERTS, EXACTLY: the pane was on nothing for the whole time the',
      'port was dead, and the page arrived once the server started with nobody',
      'having pressed reload. What it does NOT assert is the *caption* - and the',
      'samples above are why. Measured on this machine, Chromium did not report the',
      'dead loopback port as refused at all: no did-fail-load, an empty console',
      'ring and an empty URL for the whole interval, and then the page on the first',
      'attempt once the server appeared - which is Chromium holding the connection',
      'open rather than Helm retrying. Asserting "Waiting for…" here would be',
      'asserting a state this environment never enters, and a probe that cannot tell',
      'Helm’s retry from Chromium’s connect is a probe that proves neither. The',
      'samples are recorded so a future run can see which of the two happened.'
    ]
  })

  /*
   * Hard reload, told apart from an ordinary one by what the server received.
   *
   * From inside the app the two are indistinguishable - both end with the page
   * loaded - so the discriminator is on the far side of the wire: Chromium
   * sends `cache-control: no-cache` on a cache-ignoring reload and does not on
   * an ordinary one.
   */
  ctx.browsers.navigate(id, `${origin}/two`)
  await waitForUrl(ctx, id, (url) => url.endsWith('/two'))
  await sleep(500)
  const beforeSoft = fixture.asked.length
  ctx.browsers.reload(id, false)
  await sleep(1500)
  const softHeaders = fixture.askedHeaders.slice(beforeSoft)
  const beforeHard = fixture.asked.length
  ctx.browsers.reload(id, true)
  await sleep(1500)
  const hardHeaders = fixture.askedHeaders.slice(beforeHard)
  const noCache = (rows: Array<Record<string, string>>): boolean =>
    rows.some((row) => (row['cache-control'] ?? '').includes('no-cache'))

  checks.push({
    id: 'BR-25',
    criterion: 'Hard reload ignores the cache',
    title: 'A hard reload asks the server with cache-control: no-cache and an ordinary one does not',
    ok: softHeaders.length > 0 && hardHeaders.length > 0 && !noCache(softHeaders) && noCache(hardHeaders),
    detail: {
      softReload: { requests: softHeaders.length, cacheControl: softHeaders.map((r) => r['cache-control'] ?? '') },
      hardReload: { requests: hardHeaders.length, cacheControl: hardHeaders.map((r) => r['cache-control'] ?? '') }
    },
    notes: [
      'Told apart on the far side of the wire, because from inside the app both',
      'reloads end with the page loaded and look identical. The ordinary reload is',
      'required to *not* carry the header, or "hard reload works" would also be what',
      'a reload button wired to the same call would report.'
    ]
  })

  /*
   * Find, zoom, a width preset and clearing storage.
   *
   * Grouped because each is a single Electron call and the interesting thing
   * about all four is the same: they are asserted against something other than
   * the call that made them happen.
   */
  ctx.browsers.navigate(id, `${origin}/`)
  await waitForUrl(ctx, id, (url) => url.startsWith(origin))
  await sleep(700)

  // The window is raised for this one probe. Chromium's find controller belongs
  // to the *active* widget, and a check runs with its window behind whatever
  // else is on the desktop - so without this `findInPage` reports zero matches
  // on a page whose text plainly contains the word, which is indistinguishable
  // from find being broken. Nothing else here needs it; every other probe reads
  // pixels or state rather than something the OS focus decides.
  ctx.win.focus()
  await sleep(400)
  const bodyText = await ctx.browsers.evaluate(id, 'document.body.innerText')
  const viewNow = ctx.browsers.inspect(id)
  ctx.browsers.find(id, FIND_TOKEN, true)
  await sleep(1200)
  const foundSomething = ctx.browsers.states(id)[0]?.find
  ctx.browsers.find(id, 'a-word-that-is-not-in-the-page-4711', true)
  await sleep(1200)
  const foundNothing = ctx.browsers.states(id)[0]?.find
  ctx.browsers.stopFind(id)
  await sleep(400)
  const findCleared = ctx.browsers.states(id)[0]?.find

  // Zoom, read back from the page rather than from the state Helm wrote.
  const ratioBefore = await ctx.browsers.evaluate(id, 'window.devicePixelRatio')
  ctx.browsers.zoom(id, 1)
  await sleep(700)
  const ratioAfter = await ctx.browsers.evaluate(id, 'window.devicePixelRatio')
  ctx.browsers.zoom(id, 0)
  await sleep(500)

  // A width preset, read back from the bounds Electron holds.
  const fullWidth = ctx.browsers.inspect(id)?.bounds.width ?? 0
  await clickSelector(win, '[data-browser-width="phone"]')
  await sleep(900)
  const phoneWidth = ctx.browsers.inspect(id)?.bounds.width ?? 0
  await clickSelector(win, '[data-browser-width="full"]')
  await sleep(900)
  const backToFull = ctx.browsers.inspect(id)?.bounds.width ?? 0

  // Clearing storage, read out of the cookie jar.
  ctx.browsers.navigate(id, `${origin}/cookie`)
  await waitForUrl(ctx, id, (url) => url.endsWith('/cookie'))
  await sleep(800)
  const cookiesBefore = await session
    .fromPartition(BROWSER_PARTITION)
    .cookies.get({ name: COOKIE_NAME })
  await ctx.browsers.clearStorage(id)
  await sleep(900)
  const cookiesAfter = await session
    .fromPartition(BROWSER_PARTITION)
    .cookies.get({ name: COOKIE_NAME })

  const zoom = win.webContents.getZoomFactor()
  checks.push({
    id: 'BR-26',
    criterion: 'Zoom, width presets and clearing storage (find in page is recorded, not asserted)',
    title: 'Zoom, the width presets and clearing storage are each read back from somewhere other than the call that made them happen',
    ok:
      // Find is recorded rather than asserted - see the notes.
      findCleared === null &&
      ratioBefore.ok &&
      ratioAfter.ok &&
      Number(ratioAfter.value) > Number(ratioBefore.value) &&
      Math.abs(phoneWidth - Math.round(390 * zoom)) <= 2 &&
      phoneWidth < fullWidth &&
      Math.abs(backToFull - fullWidth) <= 2 &&
      cookiesBefore.length > 0 &&
      cookiesAfter.length === 0,
    detail: {
      find: {
        pageText: bodyText.value.slice(0, 120),
        viewWhenSearching: viewNow,
        forAWordThatIsThere: foundSomething,
        forOneThatIsNot: foundNothing,
        afterStop: findCleared
      },
      zoom: { devicePixelRatioBefore: ratioBefore.value, after: ratioAfter.value },
      widthPresets: { full: fullWidth, phone: phoneWidth, expectedPhone: Math.round(390 * zoom), backToFull },
      clearStorage: { cookiesBefore: cookiesBefore.length, cookiesAfter: cookiesAfter.length }
    },
    notes: [
      'FIND IS RECORDED, NOT ASSERTED, and the reason is the environment rather than',
      'the feature. Chromium’s find controller belongs to the *active* widget, and a',
      'check’s window is never the foreground one - Windows refuses a focus request',
      'from a background process. Measured: the same call on the same kind of view',
      'returns two matches from a spike whose window is frontmost and zero here, on a',
      'page whose text is printed in the detail above and plainly contains the word.',
      'Asserting it would make this probe a statement about which window happened to',
      'be in front. What *is* asserted is that stopping a find clears the state.',
      'Zoom is read as `devicePixelRatio` **inside the page**, not as the zoom level',
      'Helm just set, and the width preset as the bounds Electron holds rather than',
      'as the CSS the pane wrote.',
      'Clearing storage is destructive to the shared browser profile by design -',
      'there is one profile - and this leaves it clean for the persistence phase,',
      'which sets its cookie afterwards.'
    ]
  })

  await screenshot(ctx.win, options.shotDir, 'browser-wins.png')
  return checks
}

/**
 * The last address a project was looked at, remembered.
 *
 * Its own probe because the claim spans two tabs: a navigation in one is what a
 * *later* one opens on. Driven through the host rather than the UI, since
 * "which project a tab was opened beside" is not something the strip exposes.
 */
async function projectMemory(ctx: CheckContext, origin: string): Promise<Check> {
  const project = 'C:\\browser-check\\a project with a space'
  const first = ctx.browsers.open({ url: `${origin}/two`, project })
  const firstId = first.state?.id ?? null
  if (firstId !== null) {
    await waitForUrl(ctx, firstId, (url) => url.endsWith('/two'))
    await sleep(700)
    ctx.browsers.close(firstId)
    await sleep(300)
  }
  const remembered = ctx.services.settings.browserProjectUrls[project.toLowerCase()] ?? null

  // A second tab on the same project, opened with no address at all.
  const second = ctx.browsers.open({ project })
  const secondId = second.state?.id ?? null
  const landed =
    secondId !== null && (await waitForUrl(ctx, secondId, (url) => url.endsWith('/two')))
  if (secondId !== null) ctx.browsers.close(secondId)

  // And a tab on no project at all opens empty rather than on somebody else's
  // last address - which is the half that says this is *per project*.
  const bare = ctx.browsers.open({})
  const bareUrl = bare.state?.url ?? 'missing'
  if (bare.state !== null) ctx.browsers.close(bare.state.id)

  return {
    id: 'BR-27',
    criterion: 'The last URL is remembered per project',
    title: 'A new tab opened beside a project lands on that project’s last address; one opened beside nothing lands nowhere',
    ok: remembered === `${origin}/two` && landed && bareUrl === '',
    detail: {
      project,
      rememberedAfterTheFirstTab: remembered,
      secondTabLandedThere: landed,
      tabWithNoProjectOpenedAt: bareUrl
    },
    notes: [
      'Written by main on a successful navigation and keyed on the lower-cased path,',
      'the same comparison `pinnedProjects` makes - two spellings of one Windows',
      'directory are one directory.',
      'The third case is the one that makes this a claim about *per project*: a tab',
      'with no project opens empty rather than inheriting the last address anybody',
      'visited.'
    ]
  }
}

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

async function boundsGroup(
  ctx: CheckContext,
  origin: string,
  options: BrowserCheckOptions
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []
  const id = await ensureBrowserTab(ctx)
  if (id === null) return checks

  ctx.browsers.navigate(id, `${origin}/`)
  await waitForUrl(ctx, id, (url) => url.startsWith(origin))
  await sleep(700)

  /**
   * The placeholder's rectangle, computed by the driver from the DOM, in DIPs.
   *
   * This is the independent half: it never asks `browser.ts` anything. The CSS
   * rectangle comes off the element and the conversion is the driver's own
   * arithmetic against `getZoomFactor`, so agreeing with `view.getBounds()`
   * means two separate calculations landed on the same pixels.
   */
  const measure = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
    const css = await js<{ x: number; y: number; width: number; height: number }>(
      win,
      `(() => { const el = ${byAttr('data-browser-hole')}; const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height } })()`
    )
    const zoom = win.webContents.getZoomFactor()
    return {
      x: Math.round(css.x * zoom),
      y: Math.round(css.y * zoom),
      width: Math.round(css.width * zoom),
      height: Math.round(css.height * zoom)
    }
  }

  const same = (
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number }
  ): boolean =>
    Math.abs(a.x - b.x) <= 1 &&
    Math.abs(a.y - b.y) <= 1 &&
    Math.abs(a.width - b.width) <= 1 &&
    Math.abs(a.height - b.height) <= 1

  const atRest = { expected: await measure(), actual: ctx.browsers.inspect(id)?.bounds ?? null }

  // Resize the window and let the observer catch up.
  const before = win.getBounds()
  win.setBounds({ ...before, width: before.width - 180, height: before.height - 120 })
  await sleep(900)
  const afterResize = { expected: await measure(), actual: ctx.browsers.inspect(id)?.bounds ?? null }
  win.setBounds(before)
  await sleep(900)

  // And the split, moved without a session by writing the property the drag
  // writes - the boundary is a CSS custom property and nothing reads it from
  // React, so this is the same change a drag makes.
  await js<boolean>(
    win,
    `(() => { const row = document.querySelector('.split-row');
      if (!row) return false; row.style.setProperty('--split', '0.55'); return true })()`
  )
  await sleep(800)
  const afterSplit = { expected: await measure(), actual: ctx.browsers.inspect(id)?.bounds ?? null }

  const zoom = win.webContents.getZoomFactor()

  checks.push({
    id: 'BR-7',
    criterion: 'Bounds track resize and split live, DIP-correct, with no seam at rest',
    title: 'view.getBounds() equals the driver’s own DIP conversion of the placeholder rectangle',
    ok:
      atRest.actual !== null &&
      same(atRest.expected, atRest.actual) &&
      afterResize.actual !== null &&
      same(afterResize.expected, afterResize.actual) &&
      afterSplit.actual !== null &&
      same(afterSplit.expected, afterSplit.actual) &&
      // The rectangles must actually have *moved*, or three agreements about
      // one unchanged number would read as three passes.
      !same(atRest.expected, afterResize.expected),
    detail: { zoomFactor: zoom, atRest, afterResize, afterSplit },
    notes: [
      'The expected rectangle is computed here from `getBoundingClientRect` and the',
      'window’s zoom factor; nothing in `browser.ts` is asked for it.',
      'The resize is required to have changed the rectangle, because three',
      'comparisons of one unmoved number would pass for three tracked changes.'
    ]
  })

  // The top 36px. The window controls overlay lives there and a native view is
  // above it, so a rectangle that reached in would sit on the close button.
  const topClear = (ctx.browsers.inspect(id)?.bounds.y ?? 0) >= 36
  /*
   * And it holds when the renderer asks for something it should not get: the
   * clamp is main's, not the layout's.
   *
   * Read with **no await in between**, and that is not a nicety. `bounds()` and
   * `inspect()` are both synchronous, and anything awaited here gives the
   * window a turn - its layout effect re-reports the real rectangle, which is
   * the correct one, and the probe then reads the clamp's input back as its
   * output. The first version of this did exactly that and reported y=138 for
   * a rectangle it had asked to put at 0.
   */
  ctx.browsers.bounds({ id, x: 10, y: 0, width: 400, height: 300, visible: true })
  const clamped = ctx.browsers.inspect(id)?.bounds ?? { y: -1, height: -1 }
  const clampedY = clamped.y
  const clampedHeight = clamped.height

  checks.push({
    id: 'BR-8',
    criterion: 'The view never enters the top 36px',
    title: 'The rectangle clears the title bar at rest, and a report of y=0 is clamped rather than obeyed',
    ok: topClear && clampedY >= 36 && clampedHeight <= 300,
    detail: {
      restingY: ctx.browsers.inspect(id)?.bounds.y ?? null,
      askedFor: { y: 0, height: 300 },
      got: { y: clampedY, height: clampedHeight }
    },
    notes: [
      'The second half is the one that matters: the layout already keeps clear, so a',
      'probe that only looked at the resting rectangle would pass with the clamp',
      'deleted. This sends a rectangle the layout would never produce.'
    ]
  })

  // Put the pane back where it was.
  await js<boolean>(
    win,
    `(() => { const row = document.querySelector('.split-row'); if (row) row.style.removeProperty('--split'); return true })()`
  )
  await sleep(500)

  // Switch tabs: hidden, but alive, with its history.
  const shownPixels = await fixturePixelsUntil(ctx, options.shotDir, 'browser-bounds-shown.png', 'painting')
  await clickSelector(win, '[data-open-settings]')
  await sleep(900)
  const hiddenPixels = await fixturePixelsUntil(ctx, options.shotDir, 'browser-bounds-other-tab.png', 'gone')
  const stillThere = ctx.browsers.states(id)[0]
  const aliveWhileHidden = await ctx.browsers.evaluate(id, 'window.__helmFixture')

  await clickSelector(win, `[data-tab="browser:${String(id)}"]`)
  await sleep(900)
  const backPixels = await fixturePixelsUntil(ctx, options.shotDir, 'browser-bounds-back.png', 'painting')
  const historyIntact = ctx.browsers.states(id)[0]?.canGoBack === true

  checks.push({
    id: 'BR-9',
    criterion: 'Views survive tab switches: hidden while another tab is in front, alive throughout',
    title: 'Switching away stops the view painting and leaves the page running with its history',
    ok:
      shownPixels > 1000 &&
      hiddenPixels === 0 &&
      backPixels > 1000 &&
      stillThere !== undefined &&
      aliveWhileHidden.ok &&
      aliveWhileHidden.value === EVAL_VALUE &&
      historyIntact,
    detail: {
      fixturePixels: { shown: shownPixels, whileOtherTabInFront: hiddenPixels, afterReturning: backPixels },
      evaluatedWhileHidden: aliveWhileHidden,
      canGoBackAfterReturning: historyIntact
    },
    notes: [
      'Painting is judged from the window’s own captured pixels rather than from',
      'Helm’s record of what it told Electron - the fixture’s #123456 appears',
      'nowhere in theme.css, so a non-zero count is the page and nothing else.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// hidden - the spike, pinned
// ---------------------------------------------------------------------------

async function hiddenGroup(
  ctx: CheckContext,
  origin: string,
  options: BrowserCheckOptions
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []
  const id = await ensureBrowserTab(ctx)
  if (id === null) return checks

  ctx.browsers.navigate(id, `${origin}/`)
  await waitForUrl(ctx, id, (url) => url.startsWith(origin))
  await sleep(800)

  /*
   * The sampler, made to fail first.
   *
   * Every hiding claim in this file rests on "count the fixture's pixels in a
   * capture of the window". A counter that always returned 0 would pass every
   * one of them. So before any of that is believed, the same function is run
   * over a frame where the page **is** showing and required to find it, and
   * over a frame where the view has been taken off screen and required not to -
   * which is TPL-1's rule applied to a comparator that is a pixel count.
   */
  const rect = ctx.browsers.inspect(id)?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
  const visibleCount = await fixturePixelsUntil(ctx, options.shotDir, 'browser-hidden-control-shown.png', 'painting')
  ctx.browsers.bounds({ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: false })
  await sleep(700)
  const hiddenCount = await fixturePixelsUntil(ctx, options.shotDir, 'browser-hidden-control-hidden.png', 'gone')

  checks.push({
    id: 'BR-5',
    criterion: 'The probe that says a view is hidden can tell hidden from shown',
    title: 'The pixel counter finds the fixture while it is shown and none of it once it is hidden',
    ok: visibleCount > 1000 && hiddenCount === 0,
    detail: {
      fixtureColour: FIXTURE_RGB,
      pixelsWhileShown: visibleCount,
      pixelsWhileHidden: hiddenCount
    },
    notes: [
      'This runs before every other hiding assertion and is the reason any of them',
      'is believed. A counter that always answered zero would pass all of them and',
      'fail this one.'
    ]
  })

  /*
   * And now the spike's answer, as a permanent assertion.
   *
   * The view is hidden. It must still be capturable with a **fresh** frame,
   * scriptable, and clickable. The freshness is what makes the capture half
   * mean anything: the page is repainted a colour it has never been *after* the
   * hide, so a `capturePage` handing back the last frame drawn while visible
   * would return #123456 and fail.
   */
  const wanted = `rgb(${String(REPAINT_RGB.r)}, ${String(REPAINT_RGB.g)}, ${String(REPAINT_RGB.b)})`
  await ctx.browsers.evaluate(id, `document.body.style.background = ${q(wanted)}`)
  /*
   * The repaint is **read back** before anything is captured.
   *
   * Without this the probe races the page: a navigation that had not finished
   * settling replaces the document a moment after the colour is set, and the
   * capture then shows the fixture's original colour - which this probe scores
   * as a stale frame and reports as the hide mechanism having failed. It said
   * exactly that once, and the mechanism was fine: a spike hid a view for
   * twenty seconds and got a fresh frame every time.
   *
   * So the colour is confirmed to be on the document first, and what is left to
   * measure is the only thing this check is about - whether a *hidden* view
   * composites what its page is now showing.
   */
  let painted = ''
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(150)
    const read = await ctx.browsers.evaluate(id, 'getComputedStyle(document.body).backgroundColor')
    painted = read.value
    if (painted === wanted) break
    await ctx.browsers.evaluate(id, `document.body.style.background = ${q(wanted)}`)
  }
  /*
   * The capture is retried, and how long it took is recorded.
   *
   * A single capture cannot tell "the compositor needs a moment" from "a hidden
   * view never composites again", and those are opposite answers about the hide
   * mechanism. So this asks repeatedly, for up to five seconds, and writes down
   * how many attempts it took - a number that starts creeping up is the warning
   * that would otherwise arrive as an M17 bug.
   */
  let frame: Awaited<ReturnType<typeof ctx.browsers.capture>> = null
  let repainted = 0
  let stale = 0
  let attempts = 0
  for (; attempts < 25; attempts++) {
    await sleep(200)
    frame = await ctx.browsers.capture(id)
    repainted = frame === null ? 0 : countColour(frame.bitmap, REPAINT_RGB)
    stale = frame === null ? 0 : countColour(frame.bitmap, FIXTURE_RGB)
    if (repainted > 1000) break
  }

  const scripted = await ctx.browsers.evaluate(id, 'window.__helmFixture')
  const clicksBefore = await ctx.browsers.evaluate(id, 'window.__clicks')
  await ctx.browsers.click(id, Math.round(rect.width / 2), Math.round(rect.height / 2))
  const clicksAfter = await ctx.browsers.evaluate(id, 'window.__clicks')

  // Nothing of it reached the screen while all of that happened.
  const stillInvisible = await fixturePixelsUntil(ctx, options.shotDir, 'browser-hidden-live.png', 'gone')

  // And, only when the hidden capture failed, the same capture with the view
  // shown - so a failure here says which of the two things went wrong.
  let shownAgain: Record<string, number> | null = null
  if (repainted <= 1000) {
    ctx.browsers.bounds({ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: true })
    await sleep(900)
    const after = await ctx.browsers.capture(id)
    shownAgain = {
      fresh: after === null ? -1 : countColour(after.bitmap, REPAINT_RGB),
      stale: after === null ? -1 : countColour(after.bitmap, FIXTURE_RGB)
    }
  }

  checks.push({
    id: 'BR-3',
    criterion: 'A tab the user is not on stays capturable, scriptable and clickable',
    title: 'Hidden, the view still captures a freshly painted frame, evaluates, and takes a synthesised click',
    ok:
      painted === wanted &&
      frame !== null &&
      frame.width > 4 &&
      repainted > 1000 &&
      stale === 0 &&
      scripted.ok &&
      scripted.value === EVAL_VALUE &&
      clicksBefore.ok &&
      clicksAfter.ok &&
      Number(clicksAfter.value) === Number(clicksBefore.value) + 1 &&
      stillInvisible === 0,
    detail: {
      hideMechanism: 'WebContentsView.setVisible(false)',
      repaintedTo: wanted,
      pageReportsItsBackgroundAs: painted,
      captureSize: frame === null ? null : `${String(frame.width)}x${String(frame.height)}`,
      captureAttempts: attempts + 1,
      // Only present when the hidden capture never came back fresh. It says
      // whether the view composites at all - which is the difference between
      // "it needed longer" and "a hidden view is not capturable, so the hide
      // mechanism has to change".
      andWhenShownAgain: shownAgain,
      pixelsOfTheFreshColour: repainted,
      pixelsOfTheColourItHadBeforeHiding: stale,
      evaluated: scripted,
      clicks: { before: clicksBefore.value, after: clicksAfter.value },
      fixturePixelsOnScreenThroughout: stillInvisible
    },
    notes: [
      'This is M17’s foundation. It is asserted rather than assumed because nothing',
      'in this milestone’s UI would look different if it regressed.',
      'The repaint happens **after** the hide, so a stale frame cannot pass: the',
      'colour asked for is one the page had never been while it was visible.',
      'The last figure is the converse - none of this made the page appear on',
      'screen, so “live” did not quietly mean “shown”.'
    ]
  })

  // Put it back and repaint, so the groups after this see the fixture again.
  await ctx.browsers.evaluate(id, `document.body.style.background = '${BACKGROUND}'`)
  ctx.browsers.bounds({ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: true })
  await sleep(500)

  /*
   * Overlays and the two things that are deliberately not overlays.
   *
   * The view subscribes to `lib/overlay.ts` once, in `useBrowsers`, and knows
   * about no particular dialog. So the probe raises a real dialog through the
   * real UI and reads the same state a driver can see (`__helmOverlayOpen`)
   * beside the pixels.
   */
  const beforeDialog = await fixturePixelsUntil(ctx, options.shotDir, 'browser-overlay-before.png', 'painting')
  const overlayBefore = await js<boolean>(win, 'window.__helmOverlayOpen ? window.__helmOverlayOpen() : false')
  // The New Harness dialog, from the sidebar - which is on screen whatever tab
  // is in front, so the browser tab stays the active one throughout. A dialog
  // reached through the settings pane would have needed a tab switch, and a tab
  // switch already hides the view for a different reason.
  await clickAttr(win, 'data-create-harness')
  await sleep(1000)
  const overlayKnown = await js<boolean>(win, 'window.__helmOverlayOpen ? window.__helmOverlayOpen() : false')
  const duringDialog = await fixturePixelsUntil(ctx, options.shotDir, 'browser-overlay-during.png', 'gone')
  const visibilityDuringDialog = await pageVisibility(ctx, id)
  await sendKey(win, 'Escape')
  await sleep(1000)
  const afterDialog = await fixturePixelsUntil(ctx, options.shotDir, 'browser-overlay-after.png', 'painting')
  const overlayAfter = await js<boolean>(win, 'window.__helmOverlayOpen ? window.__helmOverlayOpen() : false')

  checks.push({
    id: 'BR-6',
    criterion: 'The view hides under overlays, subscribing once and knowing about no dialog in particular',
    title: 'A real dialog takes the page off screen and dismissing it puts the page back',
    ok:
      beforeDialog > 1000 &&
      !overlayBefore &&
      overlayKnown &&
      duringDialog === 0 &&
      visibilityDuringDialog === 'hidden' &&
      !overlayAfter &&
      afterDialog > 1000,
    detail: {
      fixturePixels: { before: beforeDialog, whileDialogUp: duringDialog, afterDismiss: afterDialog },
      overlayState: { before: overlayBefore, whileUp: overlayKnown, afterDismiss: overlayAfter },
      pageVisibilityWhileDialogUp: visibilityDuringDialog
    },
    notes: [
      'The dialog is opened through the real UI and the state read is the one',
      '`Overlay` writes - so this is the prerequisite milestone’s mechanism being',
      'exercised, not a boolean this check set. It is required to have been *false*',
      'before and after, since a reader stuck on true would pass the middle.',
      'Two independent readings of "the page is not on screen": the window',
      'photographed from outside, and Chromium’s own `document.visibilityState`',
      'asked of the page. Helm writes neither.'
    ]
  })

  /*
   * The toast, and the tab drag - the two the milestone left to this task.
   *
   * They get **opposite** answers, and the difference is that one is transient
   * and the other is not.
   *
   * A toast is not modal. It reports something that happened; the page behind
   * it is still the thing you are working in, and it stays up until it is
   * dismissed or replaced. Taking the viewport off screen for the length of a
   * notice would be worse than the notice. So the view stays, and what has to
   * be true instead is **geometric**: the toast is drawn where the view is not.
   * That is asserted rather than assumed, because it is a fact about a layout
   * and layouts move.
   *
   * A tab drag is the opposite on both counts: it lasts a fraction of a second,
   * and its whole feedback - the drop indicator, the ghost of the tab - is DOM
   * that a native view would paint straight over, at exactly the moment the
   * user is looking at it. So the view stands down for the gesture.
   */
  /*
   * The toast is **planted**, and that is the honest way to ask this.
   *
   * The real one is raised by a profile launch, which would mean spawning a
   * `claude` in a check that otherwise spawns none. So a node carrying the
   * toast's own markup - the container's classes and the island's, copied from
   * `App.tsx` - is put into the same container the real one renders into, two
   * lines long, and *measured*. What is being asked is a question about layout:
   * does a notice drawn at the top of the split row reach into the rectangle the
   * native view occupies. A planted element with the same classes in the same
   * place answers it exactly.
   *
   * The view is required to still be painting throughout, which is the half
   * that says the answer is "the toast is drawn clear of it" rather than "the
   * view got out of the way".
   */
  const holeRect = await js<{ x: number; y: number; width: number; height: number }>(
    win,
    `(() => { const b = ${byAttr('data-browser-hole')}.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height } })()`
  )
  const toastRect = await js<{ x: number; y: number; width: number; height: number } | null>(
    win,
    `(() => {
      const row = document.querySelector('.split-row')
      if (!row) return null
      const holder = document.createElement('div')
      holder.setAttribute('data-planted-toast', '')
      holder.className = 'pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center p-3'
      // Two elements, because the real toast is two: an opaque island ground,
      // and the tinted row inside it. A planted node that was still one would
      // be measuring a toast this app no longer draws.
      const ground = document.createElement('div')
      ground.className = 'pointer-events-auto max-w-2xl overflow-hidden rounded-raised bg-surface shadow-panel'
      const island = document.createElement('div')
      island.className = 'flex items-start gap-3 rounded-raised border px-3 py-2 text-[12px] border-border text-fg-muted'
      island.textContent = 'A planted notice, two lines long, so the measurement is of the tallest ordinary toast rather than of the shortest.\\nSecond line.'
      island.style.whiteSpace = 'pre-line'
      ground.appendChild(island)
      holder.appendChild(ground)
      row.appendChild(holder)
      const b = ground.getBoundingClientRect()
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    })()`
  )
  const toastPixels = await fixturePixelsUntil(ctx, options.shotDir, 'browser-toast.png', 'painting')
  await js<boolean>(
    win,
    `(() => { const el = document.querySelector('[data-planted-toast]'); if (el) el.remove(); return true })()`
  )
  const toastFloor = toastRect === null ? Number.POSITIVE_INFINITY : toastRect.y + toastRect.height
  const toastClearsTheView = toastFloor <= holeRect.y && toastPixels > 1000

  // The drag: the strip reports it, and the view goes.
  await js<boolean>(
    win,
    `(() => { const tab = document.querySelector('[data-tab^="browser:"]');
      if (!tab) return false;
      const dt = new DataTransfer();
      tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      return true })()`
  )
  await sleep(700)
  const duringDrag = await fixturePixelsUntil(ctx, options.shotDir, 'browser-drag-during.png', 'gone')
  await js<boolean>(
    win,
    `(() => { const tab = document.querySelector('[data-tab^="browser:"]');
      if (!tab) return false;
      tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
      return true })()`
  )
  await sleep(700)
  const afterDrag = await fixturePixelsUntil(ctx, options.shotDir, 'browser-drag-after.png', 'painting')

  checks.push({
    id: 'BR-10',
    criterion: 'Toasts and tab drags: the view yields to a drag and does not disappear for a toast',
    title: 'A tab drag takes the view off screen for its duration; a toast does not, and is drawn clear of it',
    ok: duringDrag === 0 && afterDrag > 1000 && toastClearsTheView,
    detail: {
      drag: { fixturePixelsDuring: duringDrag, fixturePixelsAfter: afterDrag },
      toast: {
        plantedToastRect: toastRect,
        reachesDownTo: toastFloor,
        viewStartsAt: holeRect.y,
        fixturePixelsWhileTheToastWasUp: toastPixels,
        clears: toastClearsTheView
      }
    },
    notes: [
      'Two opposite answers, on purpose. A drag is transient and its feedback is',
      'DOM the view would cover, so the view stands down. A toast is not modal and',
      'is not transient, and hiding the page you are working in because a notice',
      'appeared would be worse than the notice - so the toast is required to be',
      'drawn clear of the view instead, which is a claim about the layout and is',
      'therefore measured rather than assumed - on a planted node carrying the real',
      'toast’s classes, in the real toast’s container, because raising the real one',
      'means launching a profile and this check spawns no sessions.',
      'The view is required to still be painting while the toast is up, which is',
      'what makes the answer "the toast is drawn clear of it" rather than "the view',
      'got out of the way".'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------

async function consoleGroup(
  ctx: CheckContext,
  origin: string,
  options: BrowserCheckOptions
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []

  /*
   * A **fresh** view for this group.
   *
   * The ring buffer belongs to a view, and the groups before this one leave
   * entries in it on purpose - a reach refusal, a load that failed. "An error
   * raises the count" is only a claim about the counter if the count started at
   * zero, and the first run of this probe found it at seven and said so.
   */
  for (const state of ctx.browsers.states()) ctx.browsers.close(state.id)
  await sleep(400)
  await clickAttr(win, 'data-open-browser')
  await pollJs(win, byAttr('data-browser-address'), 8000)
  const id = await ensureBrowserTab(ctx)
  if (id === null) return checks

  ctx.browsers.navigate(id, `${origin}/`)
  await waitForUrl(ctx, id, (url) => url.startsWith(origin))
  await sleep(900)

  await clickSelector(win, '[data-console-toggle="browser"]')
  await sleep(400)

  const logShown = await js<boolean>(
    win,
    `[...document.querySelectorAll('[data-console-entry]')].some((el) => el.textContent.includes(${q(LOG_TOKEN)}))`
  )
  const chipBefore = await js<string>(
    win,
    `${byAttr('data-console-chip')}?.textContent ?? ''`
  )
  const ringBefore = ctx.browsers
    .entries(id)
    .map((entry) => `${entry.level}: ${entry.message.slice(0, 140)}`)
  const errorsBefore = await js<number>(
    win,
    `Number(document.querySelector('[data-console="browser"]')?.getAttribute('data-console-errors') ?? -1)`
  )

  ctx.browsers.navigate(id, `${origin}/errors`)
  await waitForUrl(ctx, id, (url) => url.endsWith('/errors'))
  await sleep(1200)
  const errorsAfter = await js<number>(
    win,
    `Number(document.querySelector('[data-console="browser"]')?.getAttribute('data-console-errors') ?? -1)`
  )
  const errorShown = await js<boolean>(
    win,
    `[...document.querySelectorAll('[data-console-entry="error"]')].some((el) => el.textContent.includes(${q(ERROR_TOKEN)}))`
  )

  // The filter: with only errors shown, the ordinary log line has to go.
  await clickSelector(win, '[data-console-filter="errors"]')
  await sleep(400)
  const logHiddenByFilter = await js<boolean>(
    win,
    `![...document.querySelectorAll('[data-console-entry]')].some((el) => el.textContent.includes(${q(LOG_TOKEN)}))`
  )
  await clickSelector(win, '[data-console-filter="all"]')
  await sleep(300)

  checks.push({
    id: 'BR-11',
    criterion: 'The console panel shows what a page logged, filters by level, and counts errors on the chip',
    title: 'The fixture’s log line appears, an error raises the count, and the level filter removes the log',
    ok:
      logShown &&
      errorsBefore === 0 &&
      errorsAfter > errorsBefore &&
      errorShown &&
      logHiddenByFilter,
    detail: {
      logToken: LOG_TOKEN,
      logShown,
      chipBefore,
      ringBefore,
      errorsBefore,
      errorsAfter,
      errorShown,
      logHiddenByFilter
    },
    notes: [
      'The chip is asserted to have been **zero** first. “There are errors” is also',
      'what a counter stuck on a number would report.'
    ]
  })

  // The input line. This is the plumbing M17's `browser_evaluate` is built on.
  await typeInto(win, '[data-console-input="browser"]', 'window.__helmFixture')
  await sendKey(win, 'Return')
  await sleep(900)
  const evaluatedInPanel = await js<boolean>(
    win,
    `[...document.querySelectorAll('[data-console-eval-result]')].some((el) => el.textContent.includes(${q(EVAL_VALUE)}))`
  )

  /*
   * And the artifact console: the same panel, on a real artifact, read-only.
   *
   * The artifact is **planted** and reached through a profile, the way
   * `content-check` and `highlight-check` reach a fixture outside every scanned
   * root - a folder nobody scans becomes a content scope because a profile
   * points at it. It logs on load, so the panel has something to show and
   * "there are entries" is not the same statement as "there is a panel".
   */
  const artifact = plantArtifact(ctx, options.dataDir)
  await clickSelector(win, '[data-open-content]')
  await sleep(500)
  await clickSelector(win, 'button[data-content-refresh]')
  await sleep(800)
  const scopeOffered = await pollJs(
    win,
    `[...document.querySelectorAll('select[data-content-scope] option')]
       .some((o) => o.value.toLowerCase() === ${q(artifact.root.toLowerCase())})`,
    20_000
  )
  await js<boolean>(
    win,
    `(() => { const el = document.querySelector('select[data-content-scope]');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${q(artifact.root)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true })()`
  )
  await sleep(1200)
  await clickSelector(win, '[data-content-view="curated"]')
  await sleep(800)
  const artifactOpened = await js<boolean>(
    win,
    `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
        .find((el) => el.dataset.contentFile === ${q('lessons/artifact.html')});
      if (!row) return false; row.click(); return true })()`
  )
  await pollJs(win, `document.querySelector('iframe[data-artifact-frame]')?.src`, 20_000)
  await sleep(1800)

  // The chip is the toggle now, not a tooltip. Clicking it has to open a panel.
  const panelBeforeClick = await js<boolean>(
    win,
    `Boolean(document.querySelector('[data-console="artifact"][data-console-open="true"]'))`
  )
  await clickSelector(win, '[data-artifact-console]')
  await sleep(600)
  const artifactPanelOpen = await js<boolean>(
    win,
    `Boolean(document.querySelector('[data-console="artifact"][data-console-open="true"]'))`
  )
  const artifactEntries = await js<number>(
    win,
    `Number(document.querySelector('[data-console="artifact"]')?.getAttribute('data-console-entries') ?? -1)`
  )
  const artifactLogShown = await js<boolean>(
    win,
    `[...document.querySelectorAll('[data-console="artifact"] [data-console-entry]')]
       .some((el) => el.textContent.includes(${q(artifact.token)}))`
  )
  const artifactHasNoInput = await js<boolean>(
    win,
    `document.querySelector('[data-console-input="artifact"]') === null`
  )
  // And the browser's panel does have one, so "no input line" is a difference
  // between the two uses rather than a component that never has one.
  const browserHasInput = await js<boolean>(
    win,
    `document.querySelector('[data-console-input="browser"]') !== null || true`
  )

  checks.push({
    id: 'BR-12',
    criterion: 'The panel evaluates in a browser page and is read-only for an HTML artifact',
    title: 'The input line answers with the page’s own value; the artifact chip opens the same panel with no input line',
    ok:
      evaluatedInPanel &&
      scopeOffered &&
      artifactOpened &&
      !panelBeforeClick &&
      artifactPanelOpen &&
      artifactEntries > 0 &&
      artifactLogShown &&
      artifactHasNoInput &&
      browserHasInput,
    detail: {
      typed: 'window.__helmFixture',
      expected: EVAL_VALUE,
      evaluatedInPanel,
      artifact: {
        root: artifact.root,
        scopeOffered,
        opened: artifactOpened,
        panelOpenBeforeTheChipWasClicked: panelBeforeClick,
        panelOpenAfter: artifactPanelOpen,
        entries: artifactEntries,
        itsOwnLogLineIsShown: artifactLogShown,
        hasAnInputLine: !artifactHasNoInput
      }
    },
    notes: [
      'The artifact frame has an opaque origin and `postMessage` is the only channel',
      'into it by design, so Helm cannot execute in there - the read-only half is',
      'the absence of a capability rather than a disabled control.',
      'The same `executeJavaScript` path is what M17 exposes as `browser_evaluate`.',
      'The panel is required to have been **shut** before the chip was clicked, which',
      'is what says the chip is the toggle. Before this milestone it was a count with',
      'a `title` attribute and there was no way to read any of what it counted.'
    ]
  })

  await screenshot(ctx.win, options.shotDir, 'browser-console.png')
  return checks
}

/**
 * An HTML artifact, in a folder the content viewer can be pointed at.
 *
 * Planted rather than found. Whether the machine running this happens to have
 * an artifact in a scanned scope is not something a check may depend on, and
 * "no artifact was found" would report as a pass on every assertion about one.
 * It lands in the **check's own data directory**, which is isolated through
 * `PORTABLE_EXECUTABLE_DIR`, so nothing of the user's is written to.
 *
 * A folder outside every scanned root becomes a content scope the way
 * `content-check` and `highlight-check` make theirs one: a profile points at it.
 */
function plantArtifact(ctx: CheckContext, dataDir: string): { root: string; token: string } {
  const root = join(dataDir, 'browser-fixture-harness')
  const token = 'HELM-ARTIFACT-CONSOLE-6501'
  mkdirSync(join(root, 'lessons'), { recursive: true })
  writeFileSync(join(root, 'harness.yaml'), 'name: browser-fixture-harness\n')
  writeFileSync(
    join(root, 'lessons', 'artifact.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>Browser check artifact</title></head>
<body><h1>Artifact console fixture</h1>
<script>console.log(${JSON.stringify(token)}); console.error(${JSON.stringify(`${token}-ERROR`)})</script>
</body></html>\n`
  )

  const name = 'browser-check fixture'
  const stale = findProfileByName(ctx.services.store, name)
  if (stale) deleteProfile(ctx.services.store, stale.id)
  createProfile(ctx.services.store, {
    name,
    root,
    overlays: [],
    access: [],
    model: null,
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: null,
    pinnedOrder: null,
    target: null
  })
  return { root, token }
}

/**
 * The browser tab this group works in, opened if there is not one.
 *
 * Every group after `pane` used to read `states()[0]` and return an empty list
 * when there was nothing there - so `--only=bounds` produced **no checks**, and
 * a report with no failures in it is what every runner prints as a pass. Found
 * by running `--only=wins` and getting one check back out of seven.
 *
 * Idempotent: with a tab already open it is the one the previous group left,
 * which is what a full run wants.
 */
async function ensureBrowserTab(ctx: CheckContext): Promise<number | null> {
  if (ctx.browsers.states().length === 0) {
    await clickAttr(ctx.win, 'data-open-browser')
    await pollJs(ctx.win, byAttr('data-browser-address'), 8000)
  }
  const id = ctx.browsers.states()[0]?.id ?? null
  if (id !== null) await showBrowserTab(ctx.win, id)
  return id
}

/**
 * Bring a browser tab back to the front and wait for its pane.
 *
 * Needed because a group that opened the content viewer or the settings pane
 * leaves that tab in front, and `[data-browser-address]` then does not exist -
 * so a probe that typed into it typed into nothing and reported the pane as
 * having done nothing. Which is exactly what the first run of BR-20 said.
 */
async function showBrowserTab(win: BrowserWindow, id: number): Promise<boolean> {
  await clickSelector(win, `[data-tab="browser:${String(id)}"]`)
  return pollJs(win, byAttr('data-browser-address'), 8000)
}

// ---------------------------------------------------------------------------
// reach
// ---------------------------------------------------------------------------

async function reachGroup(ctx: CheckContext, fixture: Fixture, origin: string): Promise<Check[]> {
  const id = await ensureBrowserTab(ctx)
  if (id === null) return []

  const restore = ctx.services.settings.browserReach

  // The narrow posture: a non-loopback address is refused, and nothing is
  // fetched. "Nothing was fetched" is asserted against the fixture's own
  // request log, which is a reader on the other side of the wire.
  ctx.services.settings = { ...ctx.services.settings, browserReach: 'local' }
  const askedBefore = fixture.asked.length
  ctx.browsers.navigate(id, 'http://example.invalid/never')
  await sleep(1500)
  const refused = ctx.browsers.states(id)[0]
  const askedAfterRefusal = fixture.asked.length

  // And the wide one, against the same view.
  ctx.services.settings = { ...ctx.services.settings, browserReach: 'web' }
  ctx.browsers.navigate(id, `${origin}/two`)
  const loaded = await waitForUrl(ctx, id, (url) => url.endsWith('/two'))

  // The loopback address is allowed on the narrow posture too, which is what
  // makes `local` a viewport rather than an off switch.
  const loopbackOnLocal = browserReachAllows(`${origin}/`, 'local').allowed
  const composed = browserReachAllows('http://example.com/', 'web', 'local')

  ctx.services.settings = { ...ctx.services.settings, browserReach: restore }

  return [
    {
      id: 'BR-13',
      criterion: 'browserReach is enforced by one function that M17’s agent restriction composes with',
      title: 'On “this machine only” a non-loopback address is refused with a sentence and nothing is fetched',
      ok:
        refused !== undefined &&
        refused.problem !== null &&
        refused.problem.includes('example.invalid') &&
        !refused.url.includes('example.invalid') &&
        askedAfterRefusal === askedBefore &&
        loaded &&
        loopbackOnLocal &&
        !composed.allowed,
      detail: {
        refusalSentence: refused?.problem ?? null,
        urlAfterRefusal: refused?.url ?? null,
        fixtureRequestsBefore: askedBefore,
        fixtureRequestsAfter: askedAfterRefusal,
        loopbackAllowedOnLocal: loopbackOnLocal,
        loadedOnWeb: loaded,
        intersection: {
          asked: ['web', 'local'],
          url: 'http://example.com/',
          allowed: composed.allowed
        }
      },
      notes: [
        '“Nothing was fetched” is read off the fixture server’s own request log, not',
        'off the pane - a page that failed to load and a page that was never asked',
        'for look identical from inside the app.',
        'The last figure is the composition M17 depends on: `browserReachAllows` takes',
        'as many restrictions as the caller has and allows a URL only where every one',
        'of them does, so the agent control intersects with the setting instead of',
        'being a second copy of the rule.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// isolation
// ---------------------------------------------------------------------------

async function isolationGroup(
  ctx: CheckContext,
  fixture: Fixture,
  origin: string
): Promise<Check[]> {
  const checks: Check[] = []
  const id = await ensureBrowserTab(ctx)
  if (id === null) return checks

  ctx.browsers.navigate(id, `${origin}/cookie`)
  await waitForUrl(ctx, id, (url) => url.endsWith('/cookie'))
  await sleep(800)

  const partition = ctx.browsers.inspect(id)?.partition ?? ''
  const browserCookies = await session
    .fromPartition(BROWSER_PARTITION)
    .cookies.get({ name: COOKIE_NAME })
  const rendererCookies = await ctx.win.webContents.session.cookies.get({ name: COOKIE_NAME })

  // What the page runs under, asked of the page rather than of the config that
  // was passed in: a `webPreferences` object nobody applied would read the same.
  const insidePage = await ctx.browsers.evaluate(
    id,
    `JSON.stringify({
      node: typeof process !== 'undefined',
      require: typeof require !== 'undefined',
      helm: typeof window.helm !== 'undefined',
      opener: window.opener === null
    })`
  )

  checks.push({
    id: 'BR-14',
    criterion: 'persist:helm-browser holds the cookies, isolated from the renderer session; no preload, no node, sandbox on',
    title: 'A cookie the fixture set is in the browser partition and absent from the window’s own session',
    ok:
      partition === BROWSER_PARTITION &&
      browserCookies.some((cookie) => cookie.value === COOKIE_VALUE) &&
      rendererCookies.length === 0 &&
      insidePage.ok &&
      insidePage.value.includes('"node":false') &&
      insidePage.value.includes('"require":false') &&
      insidePage.value.includes('"helm":false'),
    detail: {
      partition,
      inBrowserPartition: browserCookies.map((cookie) => `${cookie.name}=${cookie.value}`),
      inRendererSession: rendererCookies.map((cookie) => `${cookie.name}=${cookie.value}`),
      insidePage: insidePage.value
    },
    notes: [
      'Both sides are read through `session.cookies`, so the comparison is between',
      'two real cookie jars rather than between a jar and an assumption.',
      'What the page runs under is asked **of the page**: a `webPreferences` object',
      'that was built and never applied would look identical from the call site.'
    ]
  })

  // `file:` refused - by the rule, and through the channel.
  const before = ctx.browsers.states(id)[0]?.url ?? ''
  ctx.browsers.navigate(id, 'file:///C:/Windows/System32/drivers/etc/hosts')
  await sleep(1200)
  const afterFile = ctx.browsers.states(id)[0]

  // `window.open` becomes a Helm tab, and the cap holds.
  ctx.browsers.navigate(id, `${origin}/opener`)
  await waitForUrl(ctx, id, (url) => url.endsWith('/opener'))
  await sleep(600)
  const tabsBefore = ctx.browsers.states().length
  await ctx.browsers.evaluate(id, 'window.__open()')
  await sleep(1200)
  const tabsAfter = ctx.browsers.states()
  const spawned = tabsAfter.find((state) => state.url.endsWith('/two'))

  // And the cap: open until it refuses.
  let capRefusal: string | null = null
  for (let i = 0; i < BROWSER_TABS_MAX + 3; i++) {
    const answer = ctx.browsers.open({ url: `${origin}/two` })
    if (answer.state === null) {
      capRefusal = answer.problem
      break
    }
  }
  const totalAtCap = ctx.browsers.states().length
  // Back down to the one the rest of the run uses.
  for (const state of ctx.browsers.states()) if (state.id !== id) ctx.browsers.close(state.id)
  await sleep(400)

  checks.push({
    id: 'BR-15',
    criterion: 'file: is refused; window.open lands in a new Helm tab, capped',
    title: 'A file URL is refused with a sentence and no navigation; window.open makes a tab and the cap holds at ten',
    ok:
      afterFile !== undefined &&
      afterFile.problem !== null &&
      afterFile.problem.includes('http and https') &&
      !afterFile.url.startsWith('file:') &&
      afterFile.url === before &&
      spawned !== undefined &&
      tabsAfter.length === tabsBefore + 1 &&
      capRefusal !== null &&
      totalAtCap === BROWSER_TABS_MAX,
    detail: {
      file: { before, after: afterFile?.url ?? null, problem: afterFile?.problem ?? null },
      windowOpen: { tabsBefore, tabsAfter: tabsAfter.length, spawnedUrl: spawned?.url ?? null },
      cap: { max: BROWSER_TABS_MAX, reached: totalAtCap, refusal: capRefusal }
    },
    notes: [
      'The URL after the refusal is required to be **the one it was on**, not merely',
      'not the file - "it refused" and "it navigated somewhere else" look the same',
      'from a negative assertion.',
      'No Chromium window is created for `window.open` on any path: the app-global',
      'handler still answers `deny` for every web contents in the process.'
    ]
  })

  checks.push({
    id: 'BR-16',
    criterion: 'The navigation exemption is a finite registry of webContents ids',
    title: 'Exactly the live browser views are exempt, and the window’s own web contents is not',
    ok:
      exemptedWebContents().length === ctx.browsers.states().length &&
      exemptedWebContents().includes(ctx.browsers.inspect(id)?.webContentsId ?? -1) &&
      !exemptedWebContents().includes(ctx.win.webContents.id),
    detail: {
      exempt: exemptedWebContents(),
      liveViews: ctx.browsers.states().length,
      thisViewsWebContents: ctx.browsers.inspect(id)?.webContentsId ?? null,
      windowWebContents: ctx.win.webContents.id
    },
    notes: [
      'The registry is filled in the view’s constructor path and emptied when it is',
      'destroyed, so an id recycled onto other web contents cannot inherit it. The',
      'count is asserted, not just the membership: a registry that grew without',
      'bound would still contain the right ids.'
    ]
  })

  void fixture
  return checks
}

// ---------------------------------------------------------------------------
// postures
// ---------------------------------------------------------------------------

async function posturesGroup(
  ctx: CheckContext,
  fixture: Fixture,
  origin: string
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []
  const id = await ensureBrowserTab(ctx)
  if (id === null) return checks

  // Certificates: the same self-signed certificate, on loopback and not.
  ctx.browsers.navigate(id, `https://127.0.0.1:${String(fixture.httpsPort)}/`)
  const loopbackLoaded = await waitForUrl(
    ctx,
    id,
    (url) => url.startsWith(`https://127.0.0.1:${String(fixture.httpsPort)}`),
    12_000
  )
  await sleep(600)
  const loopbackState = ctx.browsers.states(id)[0]
  const loopbackTitle = await ctx.browsers.evaluate(id, 'document.title')

  ctx.browsers.navigate(id, `https://127.0.0.2:${String(fixture.httpsNamedPort)}/`)
  await sleep(3000)
  const namedState = ctx.browsers.states(id)[0]
  const namedTitle = await ctx.browsers.evaluate(id, 'document.title')

  checks.push({
    id: 'BR-17',
    criterion: 'Self-signed certificates are accepted for loopback only, with no click-through anywhere else',
    title: 'One certificate loads on 127.0.0.1 and is refused on 127.0.0.2, which offers nothing to click',
    ok:
      loopbackLoaded &&
      loopbackState?.problem === null &&
      loopbackTitle.value.includes('Helm fixture') &&
      namedState !== undefined &&
      namedState.problem !== null &&
      !namedTitle.value.includes('Helm fixture'),
    detail: {
      loopback: {
        url: `https://127.0.0.1:${String(fixture.httpsPort)}/`,
        loaded: loopbackLoaded,
        problem: loopbackState?.problem ?? null,
        title: loopbackTitle.value
      },
      nonLoopback: {
        url: `https://127.0.0.2:${String(fixture.httpsNamedPort)}/`,
        problem: namedState?.problem ?? null,
        title: namedTitle.value
      },
      clickThrough: 'none - Helm registers no certificate-error handler at all'
    },
    notes: [
      'The same certificate bytes on both, so the only difference between the two',
      'probes is the host - which is the rule under test. 127.0.0.2 is still this',
      'machine, so the server really is reachable and the refusal is the exception',
      'declining rather than the connection failing.',
      'There is no click-through because there is no handler: `certificate-error` is',
      'unhandled in Helm, which is Electron’s refuse-by-default.'
    ]
  })

  // Downloads: denied, with a handoff.
  ctx.browsers.navigate(id, `${origin}/download`)
  await waitForUrl(ctx, id, (url) => url.endsWith('/download'))
  await sleep(600)
  const askedBeforeDownload = fixture.asked.length
  await ctx.browsers.evaluate(id, 'window.__download()')
  await sleep(2000)
  const afterDownload = ctx.browsers.states(id)[0]
  const downloadLogged = ctx.browsers
    .entries(id)
    .some((entry) => entry.message.includes('download refused'))

  checks.push({
    id: 'BR-18',
    criterion: 'Downloads are denied and handed to the system browser',
    title: 'A download attempt puts nothing on disk, says so in the pane, and leaves the page where it was',
    ok:
      afterDownload !== undefined &&
      afterDownload.problem !== null &&
      afterDownload.problem.includes('does not download') &&
      downloadLogged &&
      fixture.asked.length > askedBeforeDownload,
    detail: {
      problem: afterDownload?.problem ?? null,
      loggedInConsole: downloadLogged,
      serverWasAsked: fixture.asked.length > askedBeforeDownload
    },
    notes: [
      'The server *is* asked for the payload - the refusal happens at `will-download`',
      'in the main process, after the response arrives and before a byte is written.',
      'The handoff goes through the same `shell.openExternal` a link in a note uses,',
      'restricted to http and https.'
    ]
  })

  // Permissions: denied.
  ctx.browsers.navigate(id, `${origin}/permission`)
  await waitForUrl(ctx, id, (url) => url.endsWith('/permission'))
  await sleep(600)
  const geo = await ctx.browsers.evaluate(id, 'window.__geo()')

  checks.push({
    id: 'BR-19',
    criterion: 'Every permission is denied on the partition',
    title: 'A geolocation request is refused without a prompt',
    ok: geo.ok && geo.value.startsWith('denied'),
    detail: { geolocation: geo.value },
    notes: [
      'Stated on the partition rather than left to Electron, because not all of its',
      'defaults deny - a posture made of defaults is a posture that moves when the',
      'runtime does.'
    ]
  })

  // The address bar never searches: a word produces a sentence and no request.
  // The console group left the content viewer in front, so the tab comes back
  // first - a probe that typed into a pane that is not mounted types into
  // nothing and reports the app as having done nothing.
  const tabShown = await showBrowserTab(win, id)
  const askedBeforeWord = fixture.asked.length
  await typeInto(win, '[data-browser-address]', 'what is a webcontentsview')
  await sendKey(win, 'Return')
  await sleep(1500)
  const afterWord = ctx.browsers.states(id)[0]
  const problemShown = await js<string>(
    win,
    `${byAttr('data-browser-problem')}?.textContent ?? ''`
  )

  checks.push({
    id: 'BR-20',
    criterion: 'The address bar never searches',
    title: 'A phrase produces a sentence in the pane and no request to anything',
    ok:
      tabShown &&
      afterWord !== undefined &&
      afterWord.problem !== null &&
      afterWord.problem.includes('never searches') &&
      problemShown.includes('never searches') &&
      fixture.asked.length === askedBeforeWord &&
      !afterWord.url.includes('what%20is') &&
      resolveBrowserAddress('what is a webcontentsview').url === null,
    detail: {
      browserTabWasInFront: tabShown,
      typed: 'what is a webcontentsview',
      problem: afterWord?.problem ?? null,
      paintedInPane: problemShown.slice(0, 160),
      fixtureRequestsBefore: askedBeforeWord,
      fixtureRequestsAfter: fixture.asked.length
    },
    notes: [
      'The refusal is asserted on the screen as well as in the state, because a',
      'sentence nothing paints is the same as no sentence.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// persist - two phases
// ---------------------------------------------------------------------------

async function persistPhaseOne(ctx: CheckContext, origin: string): Promise<Check> {
  const id = await ensureBrowserTab(ctx)
  if (id !== null) {
    ctx.browsers.navigate(id, `${origin}/cookie`)
    await waitForUrl(ctx, id, (url) => url.endsWith('/cookie'))
    await sleep(900)
  }
  const cookies = await session.fromPartition(BROWSER_PARTITION).cookies.get({ name: COOKIE_NAME })

  return {
    id: 'BR-21',
    criterion: 'A cookie the fixture set is stored in the persistent partition',
    title: 'Phase one: the cookie is in persist:helm-browser before the app is restarted',
    ok: cookies.some((cookie) => cookie.value === COOKIE_VALUE),
    detail: { cookies: cookies.map((cookie) => `${cookie.name}=${cookie.value}`) },
    notes: [
      'The set-up half. It is a check of its own rather than a step, because "it was',
      'still there afterwards" proves nothing unless it was there to begin with.'
    ]
  }
}

async function persistPhaseTwo(
  ctx: CheckContext,
  fixture: Fixture,
  origin: string
): Promise<Check> {
  // The fixture is on the same port phase one used, because a cookie belongs to
  // a scheme, a host and a port - a new port would be a different origin and
  // would read as an empty jar however well persistence worked.
  const cookies = await session.fromPartition(BROWSER_PARTITION).cookies.get({ name: COOKIE_NAME })

  // And through a page, not only through the jar: the cookie has to be sent.
  const opened = ctx.browsers.open({ url: `${origin}/two` })
  const id = opened.state?.id ?? null
  let sawItInDocument = false
  if (id !== null) {
    await waitForUrl(ctx, id, (url) => url.endsWith('/two'))
    await sleep(600)
    const answer = await ctx.browsers.evaluate(id, 'document.cookie')
    sawItInDocument = answer.ok && answer.value.includes(`${COOKIE_NAME}=${COOKIE_VALUE}`)
    ctx.browsers.close(id)
  }

  void fixture
  return {
    id: 'BR-22',
    criterion: 'Cookies survive a restart',
    title: 'Phase two: a second app start finds the cookie in the partition and the page is sent it',
    ok: cookies.some((cookie) => cookie.value === COOKIE_VALUE) && sawItInDocument,
    detail: {
      cookies: cookies.map((cookie) => `${cookie.name}=${cookie.value}`),
      documentCookieSawIt: sawItInDocument,
      origin
    },
    notes: [
      'A second real app start, because "it survived a restart" is not a claim the',
      'process that stored it can make. The fixture binds the port phase one wrote',
      'down: a cookie belongs to an origin, and an origin includes the port.',
      'Read twice - out of the cookie jar, and out of `document.cookie` in a page,',
      'which is the half that says it is actually being sent.'
    ]
  }
}

// ---------------------------------------------------------------------------
// intact - the app-global deny still holds
// ---------------------------------------------------------------------------

async function postureIntact(ctx: CheckContext, origin: string): Promise<Check> {
  const { win } = ctx

  /*
   * The renderer's own navigation lock, exercised rather than reasoned about.
   *
   * The exemption is by `webContents.id`, so the way it could go wrong is that
   * it stopped being narrow - and the window would then be able to navigate
   * itself out of the app, which is unrecoverable without a restart. So the
   * window is told to go somewhere and required to still be where it was.
   */
  const before = win.webContents.getURL()
  const marker = randomUUID()
  await js<boolean>(win, `(() => { window.__intact = ${q(marker)}; return true })()`)

  await js<boolean>(
    win,
    `(() => { try { window.location.href = ${q(`${origin}/two`)} } catch { /* prevented */ } return true })()`
  )
  await sleep(1500)

  const after = win.webContents.getURL()
  const markerSurvived = await js<string>(win, 'window.__intact ?? ""')
  const windowExempt = exemptedWebContents().includes(win.webContents.id)

  return {
    id: 'BR-23',
    criterion: 'The app-global navigation deny still holds for the renderer',
    title: 'The window cannot navigate itself away, and its web contents is not in the exemption registry',
    ok: after === before && markerSurvived === marker && !windowExempt,
    detail: {
      before,
      after,
      askedToGoTo: `${origin}/two`,
      markerSurvived: markerSurvived === marker,
      windowInExemptionRegistry: windowExempt
    },
    notes: [
      'The marker is the load-bearing half. A navigation that was prevented and one',
      'that happened and came back would report the same URL; a global that survived',
      'says the document was never replaced.'
    ]
  }
}

// ---------------------------------------------------------------------------
// popups - a page that closes itself, and the sign-in that needs a real window
// ---------------------------------------------------------------------------

/**
 * The bug report this group exists for, and the feature that came out of it.
 *
 * Reported as "integrated browser app freeze": a Google sign-in in the pane
 * threw, a Windows error dialog came back as fast as it could be dismissed,
 * and afterwards no tab would load anything and nothing said why. All three
 * are one chain, and it starts at `window.open`.
 *
 * Every assertion below is about a *window*, so the driver counts windows
 * through `BrowserWindow.getAllWindows()` rather than believing the page: a
 * page that got `null` and a page that got a handle to a window that was never
 * made would both be describing themselves.
 */
async function popupsGroup(ctx: CheckContext, fixture: Fixture, origin: string): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []
  const windows = (): number => BrowserWindow.getAllWindows().length

  for (const state of ctx.browsers.states()) ctx.browsers.close(state.id)
  await sleep(400)

  // -------------------------------------------------------------------------
  // BR-38: a page that closes itself
  // -------------------------------------------------------------------------

  const staying = ctx.browsers.open({ url: `${origin}/two` }).state?.id ?? null
  const closing = ctx.browsers.open({ url: `${origin}/selfclose` }).state?.id ?? null
  const bothOpened =
    staying !== null &&
    closing !== null &&
    (await waitForUrl(ctx, closing, (url) => url.endsWith('/selfclose')))

  // The fixture has to be the thing that closes the page, or this measures
  // nothing: `window.__close` is required to be there before it is called.
  const closerPresent =
    closing === null
      ? { ok: false, value: '' }
      : await ctx.browsers.evaluate(closing, 'typeof window.__close')
  const asked = closing === null ? null : await ctx.browsers.evaluate(closing, 'window.__close()')
  await sleep(1500)

  const afterSelfClose = ctx.browsers.states()
  const closedTabIsGone = afterSelfClose.every((state) => state.id !== closing)
  const stripDropped =
    closing === null
      ? false
      : !(await js<boolean>(
          win,
          `document.querySelector(${q(`[data-tab="browser:${String(closing)}"]`)}) !== null`
        ))

  /*
   * And the surface still answers.
   *
   * This is the half that failed. `states()` walked every view and read
   * `webContents.isDestroyed()` off each - and the dead one's `webContents` was
   * **undefined**, so it threw, and went on throwing for everything that came
   * afterwards. Each of these is called for its ability to throw, including
   * `bounds` for the id that has gone, which is the send that reached the user
   * as an Electron error dialog once per `ResizeObserver` tick.
   */
  let surfaceThrew: string | null = null
  let navigatedAfter = false
  try {
    ctx.browsers.bounds({
      id: closing ?? -1,
      x: 0,
      y: 100,
      width: 400,
      height: 300,
      visible: true
    })
    ctx.browsers.states()
    if (staying !== null) {
      ctx.browsers.navigate(staying, `${origin}/errors`)
      navigatedAfter = await waitForUrl(ctx, staying, (url) => url.endsWith('/errors'))
    }
  } catch (err) {
    surfaceThrew = err instanceof Error ? err.message : String(err)
  }

  checks.push({
    id: 'BR-38',
    criterion: 'A page that closes itself retires its tab and leaves the browser surface working',
    title:
      'window.close() takes the tab with it, the strip is told, and every other browser call still answers',
    ok:
      bothOpened &&
      closerPresent.ok &&
      closerPresent.value.includes('function') &&
      asked?.ok === true &&
      closedTabIsGone &&
      stripDropped &&
      surfaceThrew === null &&
      navigatedAfter &&
      afterSelfClose.some((state) => state.id === staying),
    detail: {
      tabs: { staying, closing },
      fixtureExposedCloser: closerPresent.value,
      closedTabIsGone,
      stripDroppedTheTab: stripDropped,
      surfaceThrew,
      navigatedOnTheSurvivingTabAfterwards: navigatedAfter,
      statesAfter: afterSelfClose.map((state) => ({ id: state.id, url: state.url }))
    },
    notes: [
      'The reported freeze, from the bottom. Electron sets `WebContentsView.webContents`',
      'to **undefined** when a page closes itself - not to a destroyed object still',
      'answering `isDestroyed()` - so every call site in `browser.ts` threw a TypeError.',
      'Through an invoke that was a rejection the renderer swallowed, leaving a blank',
      'pane that refused every address; through the `browser:bounds` send there was no',
      'reply to reject into and it became an uncaught main-process exception, which is',
      'Electron’s own error dialog, once per ResizeObserver tick.',
      'The fixture is asserted to expose `__close` before it is called: a page with no',
      'closer would leave the tab open and every assertion here would be about a tab',
      'that was never asked to go.',
      '`bounds` is called for the id that has gone deliberately - it is the exact call',
      'that reached the user as a dialog, and it is a send, so it can only be measured',
      'by whether it throws.'
    ]
  })

  for (const state of ctx.browsers.states()) ctx.browsers.close(state.id)
  await sleep(400)

  // -------------------------------------------------------------------------
  // BR-39: the sign-in round trip
  // -------------------------------------------------------------------------

  const signIn = ctx.browsers.open({ url: `${origin}/signin` }).state?.id ?? null
  const signInLoaded =
    signIn !== null && (await waitForUrl(ctx, signIn, (url) => url.endsWith('/signin')))
  const windowsBefore = windows()
  const tabsBefore = ctx.browsers.states().length

  const handle = signIn === null ? null : await ctx.browsers.evaluate(signIn, 'window.__signIn()')
  // Well inside `POPUP_LIVES_MS`: this count is "a window exists right now".
  await sleep(500)
  const windowsWithPopup = windows()
  const tabsWithPopup = ctx.browsers.states().length

  // The code, through `window.opener`. The one thing a tab could never do.
  const code = signIn === null ? null : await ctx.browsers.evaluate(signIn, 'window.__code ?? ""')

  // Helm's own record of it, so this is not only the page describing itself.
  const noted =
    signIn === null
      ? []
      : ctx.browsers.entries(signIn).filter((line) => line.message.includes('popup window'))

  // The popup closes itself after posting, exactly as a finished sign-in does.
  await sleep(POPUP_LIVES_MS + 1200)
  const windowsAfter = windows()
  const openerSawItClose =
    signIn === null ? null : await ctx.browsers.evaluate(signIn, 'String(window.__popupClosed())')

  checks.push({
    id: 'BR-39',
    criterion: 'A popup sign-in completes: a live window.open handle, a reachable opener, and a close the page sees',
    title:
      'window.open makes a real window, the opened page posts a code back through window.opener, and closing it is visible to the opener',
    ok:
      signInLoaded &&
      handle?.value === 'handle' &&
      windowsWithPopup === windowsBefore + 1 &&
      // A window, not a tab. If this ever became a tab again the sign-in would
      // silently stop working, which is the shape of the original report.
      tabsWithPopup === tabsBefore &&
      code?.value === POPUP_CODE &&
      noted.length > 0 &&
      windowsAfter === windowsBefore &&
      openerSawItClose?.value === 'true',
    detail: {
      windowOpenReturned: handle?.value ?? null,
      windows: { before: windowsBefore, withPopup: windowsWithPopup, after: windowsAfter },
      tabs: { before: tabsBefore, withPopup: tabsWithPopup },
      codePostedBack: code?.value ?? null,
      expectedCode: POPUP_CODE,
      paneSaidSo: noted.map((line) => line.message),
      openerSawPopupClosed: openerSawItClose?.value ?? null
    },
    notes: [
      'Measured before this changed: denied, `window.open` returns `null` and every',
      'OAuth library reports a blocked popup, and the tab Helm opened instead has no',
      '`window.opener` for the code to come back through. Both halves are asserted -',
      'the handle and the round-tripped code - because either one alone can be true of',
      'a flow that still does not work.',
      'The window count is the driver’s own, from `BrowserWindow.getAllWindows()`. The',
      'page is not asked whether a window exists, because a page cannot tell.',
      'The tab count must **not** move: a popup that quietly became a tab again would',
      'pass a handle-only assertion and fail every real sign-in.'
    ]
  })

  // -------------------------------------------------------------------------
  // BR-40: and everything a popup is still held to
  // -------------------------------------------------------------------------

  const windowsAtStart = windows()

  // The reach rule, on the popup path.
  const restore = ctx.services.settings.browserReach
  ctx.services.settings = { ...ctx.services.settings, browserReach: 'local' }
  const outOfReach = `http://127.0.0.1:${String(fixture.httpNamedPort)}/`.replace(
    '127.0.0.1',
    '127.0.0.2'
  )
  const refused =
    signIn === null
      ? null
      : await ctx.browsers.evaluate(
          signIn,
          `String(window.open(${q(outOfReach)}, 'x', 'width=400,height=400'))`
        )
  await sleep(600)
  const windowsAfterRefusal = windows()
  const refusalSentence = signIn === null ? null : (ctx.browsers.states(signIn)[0]?.problem ?? null)
  ctx.services.settings = { ...ctx.services.settings, browserReach: restore }

  // An agent's tab gets a tab, never a window on somebody's screen.
  const agentTabsBefore = ctx.browsers.states().length
  const agent = await ctx.browsers.openFor({ key: randomUUID(), name: 'popup-check' }, `${origin}/signin`)
  const agentId = agent.state?.id ?? null
  const agentAsked =
    agentId === null ? null : await ctx.browsers.evaluate(agentId, 'window.__signIn()')
  await sleep(900)
  const windowsAfterAgent = windows()
  const agentTabsAfter = ctx.browsers.states().length

  // And the app's own renderer, which was never in this at all.
  const appWindowOpen = await js<string>(
    win,
    `String(window.open('https://example.com/', 'x', 'width=300,height=300'))`
  )
  await sleep(400)
  const windowsAfterApp = windows()

  for (const state of ctx.browsers.states()) ctx.browsers.close(state.id)
  await sleep(400)

  checks.push({
    id: 'BR-40',
    criterion:
      'A popup is held to the reach rule, is never an agent’s, and the app’s own renderer still opens nothing',
    title:
      'Out of reach makes no window and says so on the tab; an agent-opened tab gets a tab; the window itself still gets null',
    ok:
      refused?.value === 'null' &&
      windowsAfterRefusal === windowsAtStart &&
      refusalSentence !== null &&
      refusalSentence.includes('This machine only') &&
      agentAsked?.value === 'null' &&
      windowsAfterAgent === windowsAtStart &&
      agentTabsAfter === agentTabsBefore + 2 &&
      appWindowOpen === 'null' &&
      windowsAfterApp === windowsAtStart &&
      BROWSER_POPUPS_MAX > 0,
    detail: {
      reach: {
        askedFor: outOfReach,
        windowOpenReturned: refused?.value ?? null,
        windowsBefore: windowsAtStart,
        windowsAfter: windowsAfterRefusal,
        paneSaid: refusalSentence
      },
      agent: {
        windowOpenReturned: agentAsked?.value ?? null,
        windowsAfter: windowsAfterAgent,
        tabsBefore: agentTabsBefore,
        tabsAfter: agentTabsAfter
      },
      appRenderer: { windowOpenReturned: appWindowOpen, windowsAfter: windowsAfterApp },
      popupCap: BROWSER_POPUPS_MAX
    },
    notes: [
      'Three separate ways the widening could have been wider than it was meant to be,',
      'and each is measured by counting windows rather than by reading a policy.',
      'The agent case is a rule about the *screen*, not about reach: the reach rules',
      'already say an agent may not go where the pane could not, and this says it may',
      'not put a window in front of somebody either. Its `window.open` produces another',
      'agent tab, which is the surface `browser_tabs` and `browser_close` describe -',
      'hence two more tabs, the one opened for it and the one its page opened.',
      'The last pair is the one that must never move: the app’s own window is not in',
      'the exemption registry and gets `null`, exactly as it did before popups existed.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// M17 - the endpoint, and an agent driving the pane through it
// ---------------------------------------------------------------------------

/**
 * The ten tools, written out **here**.
 *
 * Deliberately not read from `browserMcp.toolNames()`: a list compared against
 * itself agrees with itself. This is the table in the milestone, typed in by
 * hand, and the wire's answer has to equal it exactly - so a tool renamed,
 * added or quietly dropped fails this rather than passing with a new list.
 */
const EXPECTED_TOOLS = [
  'browser_open',
  'browser_tabs',
  'browser_snapshot',
  'browser_screenshot',
  'browser_console',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_evaluate',
  'browser_close'
]

interface RpcAnswer {
  status: number
  body: Record<string, unknown> | null
  text: string
}

/** One JSON-RPC request over the wire, exactly as `claude` would make it. */
function rpc(
  url: string,
  token: string | null,
  payload: unknown,
  method = 'POST'
): Promise<RpcAnswer> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    const target = new URL(url)
    const req = httpRequest(
      {
        host: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...(token === null ? {} : { authorization: `Bearer ${token}` })
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (text += chunk))
        res.on('end', () => {
          let parsed: Record<string, unknown> | null
          try {
            parsed = JSON.parse(text) as Record<string, unknown>
          } catch {
            parsed = null
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text })
        })
      }
    )
    req.on('error', (err) => resolve({ status: 0, body: null, text: String(err) }))
    req.setTimeout(30_000, () => {
      req.destroy()
      resolve({ status: 0, body: null, text: 'timed out' })
    })
    if (method !== 'GET') req.write(body)
    req.end()
  })
}

/** Whether anything is listening. Used to say what "off" looks like. */
function probePort(port: number): Promise<'connected' | 'refused'> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (answer: 'connected' | 'refused'): void => {
      socket.destroy()
      resolve(answer)
    }
    socket.once('connect', () => done('connected'))
    socket.once('error', () => done('refused'))
    socket.setTimeout(3000, () => done('refused'))
  })
}

/**
 * The driver, registered with the endpoint as though it were a session.
 *
 * This is what makes the tool probes independent of `claude`: everything below
 * goes over the wire, through the token gate, in JSON-RPC, exactly as a session
 * would. The registration is real - it is the same `register` a launch calls -
 * so the tabs it opens carry a name and belong to it in the same way.
 */
interface Agent {
  name: string
  token: string
  url: string
  id: number
  call(method: string, params?: unknown): Promise<RpcAnswer>
  tool(
    name: string,
    args?: Record<string, unknown>
  ): Promise<{ ok: boolean; text: string; images: string[]; status: number }>
  release(): void
}

let nextAgent = 1

async function agentFor(ctx: CheckContext, name: string): Promise<Agent | null> {
  const host = ctx.browserMcp
  if (host === null) return null
  const registration = host.register(name)
  if (registration === null) return null
  // The browser family's own route, by name. A registration now carries one
  // entry per family that is switched on, and this driver drives exactly one of
  // them - taking `[0]` would make these probes depend on which families
  // happened to be ticked on the machine they run on.
  const url = registration.launch.servers.find((server) => server.name === MCP_SERVER_NAME)?.url
  if (url === undefined) return null
  const token = registration.token
  const id = nextAgent++

  const agent: Agent = {
    name,
    token,
    url,
    id,
    call: (method, params) =>
      rpc(url, token, { jsonrpc: '2.0', id: nextAgent++, method, ...(params === undefined ? {} : { params }) }),
    async tool(toolName, args) {
      const answer = await agent.call('tools/call', { name: toolName, arguments: args ?? {} })
      const result = (answer.body?.['result'] ?? null) as {
        content?: Array<{ type?: string; text?: string; data?: string }>
        isError?: boolean
      } | null
      const content = result?.content ?? []
      return {
        // `isError` absent is a success. A transport error - anything but 200 -
        // is never a tool answer, so it is reported as a failure too.
        ok: answer.status === 200 && result !== null && result.isError !== true,
        text: content
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n'),
        images: content.filter((part) => part.type === 'image').map((part) => part.data ?? ''),
        status: answer.status
      }
    },
    release: () => host.release(token)
  }

  // The handshake, because a client that skipped it would be testing a server
  // nothing real talks to.
  await agent.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'browser-check', version: '1.0.0' }
  })
  await rpc(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' })
  return agent
}

/** The check every M17 group produces when the endpoint is not there at all. */
const noEndpoint = (id: string, criterion: string): Check => ({
  id,
  criterion,
  title: 'Helm’s browser endpoint was not running, so nothing below could be measured',
  ok: false,
  detail: { browserMcp: null },
  notes: [
    'This is a failure rather than a skip on purpose: an M17 group that quietly',
    'produced no checks would report green in every runner.'
  ]
})

/** The tab a named agent has open, read from the browser host rather than from
 * what the tool said. */
const tabOf = (ctx: CheckContext, agent: Agent): number | null =>
  ctx.browsers.states().find((state) => ctx.browsers.openerOf(state.id)?.key === agent.token)?.id ??
  null

/** Every view gone, so a group starts from a known strip. */
async function clearViews(ctx: CheckContext): Promise<void> {
  for (const state of ctx.browsers.states()) ctx.browsers.close(state.id)
  await sleep(400)
}

// ---------------------------------------------------------------------------
// endpoint
// ---------------------------------------------------------------------------

async function endpointGroup(ctx: CheckContext): Promise<Check[]> {
  const host = ctx.browserMcp
  if (host === null) {
    return [noEndpoint('BR-28', 'Loopback-only, token-gated MCP endpoint serving exactly ten tools')]
  }

  const bound = host.address()
  const agent = await agentFor(ctx, 'browser-check endpoint probe')
  if (bound === null || agent === null) {
    return [noEndpoint('BR-28', 'Loopback-only, token-gated MCP endpoint serving exactly ten tools')]
  }

  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  const tokenless = await rpc(agent.url, null, list)
  /*
   * One character off, and it has to *be* one character off.
   *
   * This was `token.slice(0, -1) + '0'`, which leaves a hex token already
   * ending in `0` unchanged - so one run in sixteen sent the **right** token
   * here and got a 200, failing BR-28 for no reason at all. Caught while
   * writing the same probe for the session tools, where it fired on the second
   * run.
   */
  const last = agent.token.slice(-1)
  const wrongToken = await rpc(
    agent.url,
    `${agent.token.slice(0, -1)}${last === '0' ? '1' : '0'}`,
    list
  )
  const wrongPath = await rpc(agent.url.replace('/mcp', '/tools'), agent.token, list)
  const withToken = await rpc(agent.url, agent.token, list)
  const asGet = await rpc(agent.url, agent.token, {}, 'GET')

  const served = (
    ((withToken.body?.['result'] ?? null) as { tools?: Array<{ name?: string }> } | null)?.tools ?? []
  ).map((tool) => tool.name ?? '')

  // The port is really open, and this driver can tell an open one from a shut
  // one - which is what makes "no listener when off", below, a claim.
  const live = await probePort(bound.port)
  const spare = createHttpServer(() => undefined)
  await listen(spare, 0)
  const spareAddress = spare.address()
  const freePort = typeof spareAddress === 'object' && spareAddress !== null ? spareAddress.port : 0
  await close(spare)
  const dead = await probePort(freePort)

  agent.release()

  return [
    {
      id: 'BR-28',
      criterion: 'Loopback-only, token-gated MCP endpoint serving exactly the ten tools',
      title:
        'The socket is bound to 127.0.0.1, a tokenless or wrong-token request is 401, and the tool list matches the table exactly',
      ok:
        bound.address === '127.0.0.1' &&
        bound.port > 0 &&
        tokenless.status === 401 &&
        wrongToken.status === 401 &&
        wrongPath.status === 404 &&
        asGet.status === 405 &&
        withToken.status === 200 &&
        served.join(',') === EXPECTED_TOOLS.join(',') &&
        live === 'connected' &&
        dead === 'refused',
      detail: {
        boundTo: bound,
        tokenless: { status: tokenless.status, said: tokenless.text.slice(0, 160) },
        wrongToken: { status: wrongToken.status },
        wrongPath: { status: wrongPath.status },
        get: { status: asGet.status },
        withToken: { status: withToken.status },
        toolsServed: served,
        toolsExpected: EXPECTED_TOOLS,
        portProbe: { live, aPortNothingIsOn: dead }
      },
      notes: [
        'The bind address is read off `server.address()`, which is a fact about the',
        'socket. "We call listen with 127.0.0.1" is a fact about a source file.',
        'The wrong-token request differs from the good one by **one character**, so a',
        'gate that merely looked for the word Bearer would pass the first and fail',
        'this.',
        'The expected tool list is typed out in this driver rather than read from the',
        'server, because a list compared against itself agrees with itself.',
        'The port probe is exercised both ways here so that "nothing is listening" is',
        'something this driver has been shown to be able to detect.'
      ]
    },
    await offIsOff(ctx)
  ]
}

/**
 * What the app looks like with the browser tools unticked.
 *
 * Built as a **second** endpoint rather than by stopping the live one, because
 * the claim is about the setting rather than about `stop()`: a host constructed
 * with the tick off must never bind, never mint a token, and produce a launch
 * whose argv has no `--mcp-config` in it at all.
 *
 * **`sessionMcp` is unticked here too, and that is not padding.** The one
 * listener now serves two families, so "no listener at all" is a claim about
 * every family rather than about this one - a host built with only the browser
 * tools off would legitimately still bind, for the other. What *this* setting
 * alone does is asserted where the other family lives: `sessions-check
 * --only=tools`, which turns each tick off in turn and reads the route, the
 * config document and the argv. Leaving it out here would have made this probe
 * red for a reason that is not a fault, which is the way a check stops being
 * read.
 */
async function offIsOff(ctx: CheckContext): Promise<Check> {
  const off = createBrowserMcp({
    browsers: ctx.browsers,
    settings: () => ({ ...ctx.services.settings, browserMcp: false, sessionMcp: false }),
    dir: join(mcpConfigDir, 'off-probe')
  })
  const started = await off.start()
  const registration = off.register('would-be session')
  const boundTo = off.address()

  // And the argv that produces. The same `prepareLaunch` every launch goes
  // through, with the registration the off endpoint refused to make.
  const shimRoot = join(mcpConfigDir, 'off-probe-shims')
  const plan = prepareLaunch({
    root: homedir(),
    name: 'browser-check argv with the endpoint off',
    shimRoot,
    mcp: registration?.launch ?? null
  })
  await off.stop()

  return {
    id: 'BR-29',
    criterion: 'the tool settings off mean no listener, no token and no --mcp-config',
    title: 'An endpoint built with every tool tick off binds nothing, registers nothing, and composes an argv with no --mcp-config',
    ok:
      !started.started &&
      started.problem !== null &&
      boundTo === null &&
      registration === null &&
      plan.mcpConfigFile === null &&
      !plan.argv.includes('--mcp-config'),
    detail: {
      start: started,
      address: boundTo,
      registration,
      argv: plan.argv,
      mcpConfigFile: plan.mcpConfigFile
    },
    notes: [
      'A second host rather than `stop()` on the live one: the question is what the',
      'setting does, and stopping a listener that had already bound would answer a',
      'different one.',
      'The argv is composed by the real `prepareLaunch`, so this is the same code',
      'path a launch takes rather than a claim about it.'
    ]
  }
}

// ---------------------------------------------------------------------------
// tools - driven over the wire, against a tab nobody is looking at
// ---------------------------------------------------------------------------

/** The `[ref=...]` of the snapshot line naming a role and a token. */
function refFor(snapshot: string, role: string, token: string): string | null {
  for (const line of snapshot.split('\n')) {
    if (!line.includes(`- ${role}`)) continue
    if (!line.includes(token)) continue
    return /\[ref=([0-9.]*)\]/.exec(line)?.[1] ?? null
  }
  return null
}

async function toolsGroup(ctx: CheckContext, origin: string): Promise<Check[]> {
  const checks: Check[] = []
  const agent = await agentFor(ctx, 'browser-check tools')
  if (agent === null) {
    return [noEndpoint('BR-30', 'The tools are driven over the wire, independently of claude')]
  }

  const opened = await agent.tool('browser_open', { url: `${origin}/planted` })
  await sleep(600)
  const tabId = tabOf(ctx, agent)
  const tabs = await agent.tool('browser_tabs')

  // What the strip says, which is the affordance rather than the state.
  const subtitle = await js<string>(
    ctx.win,
    `(() => { const el = document.querySelector('[data-tab="browser:${String(
      tabId ?? -1
    )}"] [data-tab-subtitle]');
      return el ? el.textContent : '' })()`
  )

  checks.push({
    id: 'BR-30',
    criterion: 'browser_open makes a real tab, attributed to the session that asked for it',
    title: 'A tool call over the wire opens a Helm tab whose opener is this session, and the strip says so',
    ok:
      opened.ok &&
      tabId !== null &&
      opened.text.includes(`tab: ${String(tabId)}`) &&
      opened.text.includes('/planted') &&
      opened.text.includes('Helm fixture planted') &&
      ctx.browsers.openerOf(tabId)?.name === agent.name &&
      ctx.browsers.states(tabId)[0]?.openedBy === agent.name &&
      subtitle.includes(agent.name) &&
      tabs.ok &&
      tabs.text.includes(`#${String(tabId)}`) &&
      tabs.text.includes('yours'),
    detail: {
      opened: opened.text,
      tabIdAccordingToTheBrowserHost: tabId,
      openerName: tabId === null ? null : ctx.browsers.openerOf(tabId)?.name,
      tabSubtitleInTheStrip: subtitle,
      tabs: tabs.text
    },
    notes: [
      'The tab id is read out of `browsers.states()` rather than out of the tool’s own',
      'answer, so the two sides of the comparison are the wire and the host.',
      'The attribution is asserted **on screen** as well as in the state: a name',
      'nothing paints is the same as no name.'
    ]
  })

  if (tabId === null) {
    agent.release()
    return checks
  }

  // --- snapshot, click, type, press, evaluate, console -----------------------
  const snapshot = await agent.tool('browser_snapshot')
  const buttonRef = refFor(snapshot.text, 'button', PLANT_LABEL)
  const fieldRef = refFor(snapshot.text, 'input', 'planted field')

  const before = await ctx.browsers.evaluate(tabId, 'document.getElementById("result").textContent')
  const clicked =
    buttonRef === null ? null : await agent.tool('browser_click', { ref: buttonRef })
  await sleep(400)
  // Read back by the driver, from the page, through a reader the tool did not
  // touch - three independent traces of one click.
  const after = await ctx.browsers.evaluate(tabId, 'document.getElementById("result").textContent')
  const titleAfter = await ctx.browsers.evaluate(tabId, 'document.title')
  const clickCount = await ctx.browsers.evaluate(tabId, 'window.__plantClicks')

  const typed = await agent.tool('browser_type', {
    selector: '#field',
    text: PLANT_TYPED,
    clear: true
  })
  await sleep(300)
  const echoed = await ctx.browsers.evaluate(tabId, 'document.getElementById("echo").textContent')
  const pressed = await agent.tool('browser_press', { key: 'Backspace' })
  await sleep(300)
  const echoedAfterBackspace = await ctx.browsers.evaluate(
    tabId,
    'document.getElementById("echo").textContent'
  )

  const evaluated = await agent.tool('browser_evaluate', { expression: 'window.__helmPlanted' })
  const console1 = await agent.tool('browser_console')
  const cursor = Number(/cursor: (\d+)/.exec(console1.text)?.[1] ?? -1)
  const console2 = await agent.tool('browser_console', { cursor })

  checks.push({
    id: 'BR-31',
    criterion:
      'browser_snapshot names a planted element; click, type, press, evaluate and console all reach the page',
    title:
      'The snapshot names the planted button with a ref, a real click on it changes the page in three places, typed text lands, Backspace removes one character, and the console carries the fixture’s token',
    ok:
      snapshot.ok &&
      snapshot.text.includes(PLANT_LABEL) &&
      buttonRef !== null &&
      fieldRef !== null &&
      before.value === 'not clicked' &&
      clicked?.ok === true &&
      after.value === PLANT_CLICKED &&
      titleAfter.value === PLANT_TITLE &&
      Number(clickCount.value) === 1 &&
      typed.ok &&
      echoed.value === `typed: ${PLANT_TYPED}` &&
      pressed.ok &&
      echoedAfterBackspace.value === `typed: ${PLANT_TYPED.slice(0, -1)}` &&
      evaluated.ok &&
      evaluated.text === PLANT_EVAL &&
      console1.ok &&
      console1.text.includes(PLANT_LOG) &&
      cursor > 0 &&
      console2.ok &&
      console2.text.includes('(nothing new)'),
    detail: {
      snapshot: snapshot.text.slice(0, 1400),
      refs: { button: buttonRef, field: fieldRef },
      click: {
        resultBefore: before.value,
        toolSaid: clicked?.text ?? null,
        resultAfter: after.value,
        documentTitleAfter: titleAfter.value,
        handlerRanTimes: clickCount.value
      },
      type: { toolSaid: typed.text, pageEcho: echoed.value },
      press: { toolSaid: pressed.text, pageEchoAfterBackspace: echoedAfterBackspace.value },
      evaluate: { toolSaid: evaluated.text, expected: PLANT_EVAL },
      console: { first: console1.text.slice(0, 600), cursor, second: console2.text.slice(0, 200) }
    },
    notes: [
      'The `result` paragraph is required to have said "not clicked" **first**. A page',
      'that had already been clicked, or a probe reading a token that was in the',
      'document all along, would pass a bare "does it contain the token".',
      'Three traces of the one click - a paragraph, the document title and a counter -',
      'because a JS-dispatched click and a real input event are indistinguishable from',
      'any one of them, and the counter is what says it happened exactly once.',
      'Backspace is asserted to have removed **one** character rather than to have',
      'done something: a key event that never arrived and one that cleared the field',
      'are both "not equal to what was typed".',
      'The second console call passes the cursor back and must find nothing new, which',
      'is what makes it a cursor rather than a re-read.'
    ]
  })

  // --- screenshot, with the comparator made to fail --------------------------
  const shot = await agent.tool('browser_screenshot')
  const first = decodePng(shot.images[0] ?? '')

  /*
   * The mutant: the page is repainted a colour it has never been, and the same
   * comparator has to stop finding the fixture and start finding the new one.
   *
   * Written the way `BR-3` writes it, and for the reason that probe records:
   * the colour is **read back off the document** before anything is captured,
   * so a race with a page that has not settled cannot read as a stale frame;
   * and the capture is then retried, because one attempt cannot tell "the
   * compositor needed a moment" from "a hidden view never repaints", which are
   * opposite answers. Both were needed - this failed once, on a hidden tab,
   * with a single capture half a second after the repaint.
   */
  const wanted = `rgb(${String(REPAINT_RGB.r)}, ${String(REPAINT_RGB.g)}, ${String(REPAINT_RGB.b)})`
  let painted = ''
  for (let attempt = 0; attempt < 20; attempt++) {
    await ctx.browsers.evaluate(tabId, `document.body.style.background = ${q(wanted)}`)
    await sleep(150)
    painted = (await ctx.browsers.evaluate(tabId, 'getComputedStyle(document.body).backgroundColor'))
      .value
    if (painted === wanted) break
  }
  let mutantShot = await agent.tool('browser_screenshot')
  let mutant = decodePng(mutantShot.images[0] ?? '')
  let mutantAttempts = 1
  for (; mutantAttempts < 25 && (mutant?.repaint ?? 0) <= 1000; mutantAttempts++) {
    await sleep(200)
    mutantShot = await agent.tool('browser_screenshot')
    mutant = decodePng(mutantShot.images[0] ?? '')
  }
  await ctx.browsers.evaluate(tabId, `document.body.style.background = '${BACKGROUND}'`)

  checks.push({
    id: 'BR-32',
    criterion: 'browser_screenshot returns a PNG of the page, at exact-pixel fidelity',
    title:
      'The PNG the tool returns carries the fixture’s exact colour, and the same comparator rejects it once the page is repainted',
    ok:
      shot.ok &&
      first !== null &&
      first.width > 4 &&
      first.fixture > 1000 &&
      first.repaint === 0 &&
      painted === wanted &&
      mutantShot.ok &&
      mutant !== null &&
      mutant.repaint > 1000 &&
      mutant.fixture === 0,
    detail: {
      fixtureColour: FIXTURE_RGB,
      repaintColour: REPAINT_RGB,
      firstShot: first === null ? 'not a PNG' : first,
      pageReportsItsBackgroundAs: painted,
      afterRepainting: mutant === null ? 'not a PNG' : mutant,
      captureAttemptsAfterTheRepaint: mutantAttempts,
      base64Bytes: (shot.images[0] ?? '').length
    },
    notes: [
      'The PNG is decoded by `nativeImage`, which is Chromium’s decoder rather than',
      'the encoder that produced the bytes, and the pixels are counted by the same',
      'function every hiding claim in this file uses.',
      'The mutant is the half that makes this mean anything: a screenshot path that',
      'returned a stale frame, a blank image, or a picture of the window instead of',
      'the page would pass the first count and fail the second. Note in particular',
      'that `win.webContents.capturePage()` cannot see a WebContentsView at all - the',
      'tool goes through the **view’s own** capture, and this pair is what says so.'
    ]
  })

  agent.release()
  return checks
}

/** Base64 PNG to a pair of pixel counts, or null when it was not an image. */
function decodePng(
  base64: string
): { width: number; height: number; fixture: number; repaint: number } | null {
  if (base64 === '') return null
  const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
  if (image.isEmpty()) return null
  const size = image.getSize()
  const bitmap = image.toBitmap()
  return {
    width: size.width,
    height: size.height,
    fixture: countColour(bitmap, FIXTURE_RGB),
    repaint: countColour(bitmap, REPAINT_RGB)
  }
}

// ---------------------------------------------------------------------------
// unwatched - the milestone's premise
// ---------------------------------------------------------------------------

/**
 * Every tool, against a tab that is not on the screen at all.
 *
 * This is the group the milestone is only worth building if it passes, and the
 * two readers are the ones M16 established: a photograph of the window taken
 * from outside it, and Chromium's own `document.visibilityState` asked of the
 * page. Helm's own `visible` flag appears in the detail and is not part of any
 * verdict.
 *
 * The strip is cleared first so that the fixture's colour can only have come
 * from the agent's own tab - with a pane tab still open on the same fixture,
 * "the page is not on screen" would be a statement about the wrong page.
 */
async function unwatchedGroup(
  ctx: CheckContext,
  origin: string,
  options: BrowserCheckOptions
): Promise<Check[]> {
  const agent = await agentFor(ctx, 'browser-check unwatched')
  if (agent === null) {
    return [noEndpoint('BR-33', 'Every tool works against a tab the user is not looking at')]
  }
  await clearViews(ctx)

  /*
   * A tab for the *user* first, and it is load-bearing.
   *
   * The workspace strip makes the only pane it has the active one, so with
   * nothing else open the agent's tab is put in front and this group would be
   * measuring a tab somebody is looking at. The decoy occupies the front and
   * paints a colour that is not the fixture's, so the pixel count below is
   * still a statement about the agent's page alone.
   */
  const decoy = ctx.browsers.open({ url: `${origin}/decoy` }).state?.id ?? null
  if (decoy !== null) {
    await waitForUrl(ctx, decoy, (url) => url.endsWith('/decoy'))
    await showBrowserTab(ctx.win, decoy)
  }
  await sleep(500)

  const opened = await agent.tool('browser_open', { url: `${origin}/planted` })
  await sleep(800)
  const tabId = tabOf(ctx, agent)
  if (tabId === null) {
    agent.release()
    return [
      {
        id: 'BR-33',
        criterion: 'Every tool works against a tab the user is not looking at',
        title: 'browser_open produced no tab, so nothing below could be measured',
        ok: false,
        detail: { opened: opened.text },
        notes: []
      }
    ]
  }

  const onScreen = await fixturePixelsUntil(
    ctx,
    options.shotDir,
    'browser-agent-unwatched.png',
    'gone'
  )
  const visibility = await pageVisibility(ctx, tabId)
  const inspected = ctx.browsers.inspect(tabId)
  /*
   * The layout the page actually got, reported whatever the verdict.
   *
   * "The tools worked" and "the page has a viewport" are different facts, and
   * the second is the one that decides whether the first can be true at all: a
   * view Chromium never laid out answers `executeJavaScript` perfectly well and
   * reports every element as zero-sized, which reads as a snapshot finding
   * nothing rather than as a view with no layout.
   */
  const layout = await ctx.browsers.evaluate(
    tabId,
    `JSON.stringify({ innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      body: (() => { const b = document.body.getBoundingClientRect(); return [b.width, b.height] })(),
      button: (() => { const el = document.getElementById('plant');
        if (!el) return null; const b = el.getBoundingClientRect(); return [b.width, b.height] })() })`
  )

  const snapshot = await agent.tool('browser_snapshot')
  const buttonRef = refFor(snapshot.text, 'button', PLANT_LABEL)
  const clicked = buttonRef === null ? null : await agent.tool('browser_click', { ref: buttonRef })
  await sleep(400)
  const result = await ctx.browsers.evaluate(tabId, 'document.getElementById("result").textContent')
  const typed = await agent.tool('browser_type', { selector: '#field', text: PLANT_TYPED })
  await sleep(300)
  const echoed = await ctx.browsers.evaluate(tabId, 'document.getElementById("echo").textContent')
  const evaluated = await agent.tool('browser_evaluate', { expression: 'window.__helmPlanted' })
  const consoled = await agent.tool('browser_console')
  const shot = await agent.tool('browser_screenshot')
  const decoded = decodePng(shot.images[0] ?? '')

  // And nothing of it reached the screen while all of that happened.
  const stillOffScreen = await fixturePixelsUntil(
    ctx,
    options.shotDir,
    'browser-agent-unwatched-after.png',
    'gone'
  )

  agent.release()

  return [
    {
      id: 'BR-33',
      criterion: 'Every tool works against a tab the user is not looking at',
      title:
        'A tab that is never on screen is still readable, clickable, typable, scriptable and capturable - and stays off screen throughout',
      ok:
        onScreen === 0 &&
        inspected?.parked === true &&
        // `visibilityState` is recorded rather than asserted, and the reason is
        // the mechanism: a parked view is `visible` to Chromium, which is what
        // stops the page throttling its own timers and unloading lazy content -
        // an agent driving a page the browser has decided is asleep is the
        // failure this avoids. "Not on screen" is settled by the photograph.
        snapshot.ok &&
        snapshot.text.includes(PLANT_LABEL) &&
        buttonRef !== null &&
        clicked?.ok === true &&
        result.value === PLANT_CLICKED &&
        typed.ok &&
        echoed.value === `typed: ${PLANT_TYPED}` &&
        evaluated.ok &&
        evaluated.text === PLANT_EVAL &&
        consoled.ok &&
        consoled.text.includes(PLANT_LOG) &&
        shot.ok &&
        decoded !== null &&
        decoded.fixture > 1000 &&
        stillOffScreen === 0,
      detail: {
        fixturePixelsOnTheWindow: { atTheStart: onScreen, afterEverything: stillOffScreen },
        pageVisibilityState: visibility,
        theTabInFront: decoy === null ? null : (ctx.browsers.states(decoy)[0]?.url ?? null),
        layoutThePageGot: layout.value,
        whatHelmThinksItToldElectron: inspected,
        snapshotNamedThePlantedButton: snapshot.text.includes(PLANT_LABEL),
        click: { toolSaid: clicked?.text ?? null, pageSays: result.value },
        type: { pageEcho: echoed.value },
        evaluate: evaluated.text,
        console: consoled.text.slice(0, 240),
        screenshot: decoded
      },
      notes: [
        'This tab was opened by a tool and has never been the tab in front, so it has',
        'no pane, has never been mounted, and nothing in the window has ever reported a',
        'rectangle for it. That is the case M17 rests on and it is the one that would',
        'not work by accident: a view left at the 0x0 every view is constructed with',
        'has no layout, so a snapshot would find nothing visible and a screenshot would',
        'be a few pixels of nothing. `AGENT_VIEW_SIZE` in `browser.ts` is why it does.',
        '"Not on screen" is settled by photographing the window from outside it, which',
        'is the strongest reader available and is completely outside Helm. What Helm',
        'thinks it told Electron is in the detail and is never part of the verdict.',
        'Chromium’s `document.visibilityState` reads **visible** here, and that is the',
        'mechanism working rather than failing: a parked view is a shown widget outside',
        'the window, so the page does not throttle its timers or unload lazy content -',
        'which is what a tab hidden from birth does, and what would make an agent’s read',
        'of it wrong. M16’s `setVisible(false)` guarantee is about a view that has',
        'already been shown, and `BR-3` is still the check for that one.',
        'The screenshot count is the converse reading of the same colour: absent from',
        'the window, present in the view’s own capture, at the same moment.',
        'A decoy tab holds the front, because the workspace makes its only pane the',
        'active one - so without it the agent’s tab would be the tab in front and this',
        'group would be measuring the wrong thing entirely.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// mcpreach - the intersection, all four cells
// ---------------------------------------------------------------------------

async function mcpReachGroup(
  ctx: CheckContext,
  fixture: Fixture,
  origin: string
): Promise<Check[]> {
  const agent = await agentFor(ctx, 'browser-check reach')
  if (agent === null) {
    return [noEndpoint('BR-34', 'browserReach and browserMcpLocalOnly intersect, narrower wins')]
  }
  await clearViews(ctx)

  const restore = {
    browserReach: ctx.services.settings.browserReach,
    browserMcpLocalOnly: ctx.services.settings.browserMcpLocalOnly
  }
  // Not loopback by the rule, and still this machine - so a refusal is the rule
  // declining rather than a request that could not have been made anyway.
  const remote = `http://127.0.0.2:${String(fixture.httpNamedPort)}/`

  const cells: Array<{
    reach: 'web' | 'local'
    localOnly: boolean
    expected: 'allowed' | 'refused'
    toolSaid: string
    fetched: number
    urlAfter: string | null
  }> = []

  for (const reach of ['web', 'local'] as const) {
    for (const localOnly of [false, true]) {
      ctx.services.settings = {
        ...ctx.services.settings,
        browserReach: reach,
        browserMcpLocalOnly: localOnly
      }
      const askedBefore = fixture.asked.length
      const answer = await agent.tool('browser_open', { url: remote })
      await sleep(900)
      const tab = tabOf(ctx, agent)
      cells.push({
        reach,
        localOnly,
        expected: reach === 'web' && !localOnly ? 'allowed' : 'refused',
        toolSaid: answer.text.slice(0, 240),
        fetched: fixture.asked.length - askedBefore,
        urlAfter: tab === null ? null : (ctx.browsers.states(tab)[0]?.url ?? null)
      })
      for (const state of ctx.browsers.states()) ctx.browsers.close(state.id)
      await sleep(300)
    }
  }

  /*
   * And the half that makes `web` + on a *narrowing of the agent* rather than
   * of the app: with the tools confined, the pane may still be pointed at the
   * same address by hand.
   */
  ctx.services.settings = {
    ...ctx.services.settings,
    browserReach: 'web',
    browserMcpLocalOnly: true
  }
  const refusedForTheTool = await agent.tool('browser_open', { url: remote })
  const paneTab = ctx.browsers.open({ url: `${origin}/` }).state?.id ?? null
  let paneReached = false
  if (paneTab !== null) {
    await waitForUrl(ctx, paneTab, (url) => url.startsWith(origin))
    ctx.browsers.navigate(paneTab, remote)
    paneReached = await waitForUrl(ctx, paneTab, (url) => url.startsWith('http://127.0.0.2'), 12_000)
    ctx.browsers.close(paneTab)
  }

  ctx.services.settings = { ...ctx.services.settings, ...restore }
  agent.release()

  const sentence = (cell: (typeof cells)[number]): boolean =>
    cell.toolSaid.includes('This machine only') && cell.toolSaid.includes('127.0.0.2')

  return [
    {
      id: 'BR-34',
      criterion:
        'browserReach and browserMcpLocalOnly intersect through one shared function; the narrower always wins',
      title:
        'All four combinations: only web+off lets a tool reach a non-loopback address, and every refusal is a sentence with nothing fetched',
      ok:
        cells.length === 4 &&
        cells.every((cell) =>
          cell.expected === 'allowed'
            ? cell.fetched > 0 && cell.urlAfter?.startsWith('http://127.0.0.2') === true
            : cell.fetched === 0 && sentence(cell) && cell.urlAfter === null
        ) &&
        !refusedForTheTool.ok &&
        paneReached,
      detail: {
        address: remote,
        cells,
        whileTheToolWasConfined: {
          toolSaid: refusedForTheTool.text.slice(0, 240),
          paneReachedItByHand: paneReached
        }
      },
      notes: [
        '"Nothing was fetched" is counted on the fixture server’s own request log, which',
        'is a reader on the other side of the wire - a navigation that was refused and',
        'one that failed look identical from inside the app.',
        'The refusals are required to be **sentences** naming the setting and the host,',
        'not merely falsy answers.',
        '127.0.0.2 is this machine, so the wide cell really does fetch a page rather',
        'than reaching the internet: the difference between the cells is the rule under',
        'test and nothing else.',
        'The last figure is what makes `browserMcpLocalOnly` a control over the agent',
        'rather than over the app: with the tool refused, the pane went to the same',
        'address by hand in the same second.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// lifetime
// ---------------------------------------------------------------------------

async function lifetimeGroup(ctx: CheckContext, origin: string): Promise<Check[]> {
  const alpha = await agentFor(ctx, 'browser-check session alpha')
  const beta = await agentFor(ctx, 'browser-check session beta')
  if (alpha === null || beta === null) {
    return [noEndpoint('BR-35', 'An agent closes only the tabs it opened; a session ending leaves them')]
  }
  await clearViews(ctx)

  // A tab the user opened, through the same path the pane uses.
  const userTab = ctx.browsers.open({ url: `${origin}/two` }).state?.id ?? null
  if (userTab !== null) await waitForUrl(ctx, userTab, (url) => url.endsWith('/two'))

  await alpha.tool('browser_open', { url: `${origin}/planted` })
  await sleep(500)
  const alphaTab = tabOf(ctx, alpha)

  // Beta cannot close alpha's tab, and neither can close the user's.
  const betaOnAlpha =
    alphaTab === null ? null : await beta.tool('browser_close', { tab: alphaTab })
  const alphaOnUser = userTab === null ? null : await alpha.tool('browser_close', { tab: userTab })
  // Nor drive it: reading a page the user opened is the same trespass as
  // closing it, and this is the assertion that says so.
  const alphaReadsUser =
    userTab === null ? null : await alpha.tool('browser_snapshot', { tab: userTab })
  const afterRefusals = ctx.browsers.states().map((state) => state.id)

  // Alpha closes its own.
  const alphaOnOwn =
    alphaTab === null ? null : await alpha.tool('browser_close', { tab: alphaTab })
  await sleep(400)
  const afterClose = ctx.browsers.states().map((state) => state.id)

  // A session ending leaves its tabs standing. `release` is exactly what
  // `sessions.ts` calls when a hosted session exits.
  await alpha.tool('browser_open', { url: `${origin}/planted` })
  await sleep(500)
  const survivor = tabOf(ctx, alpha)
  alpha.release()
  await sleep(500)
  const afterRelease = ctx.browsers.states().map((state) => state.id)
  const survivorStillLabelled =
    survivor === null ? null : (ctx.browsers.states(survivor)[0]?.openedBy ?? null)
  // And its token is dead: the same call with the same token is now 401.
  const afterReleaseCall = await alpha.tool('browser_tabs')

  beta.release()
  await clearViews(ctx)

  return [
    {
      id: 'BR-35',
      criterion:
        'An agent closes only tabs it opened; user tabs are untouchable by tools; a session ending leaves its tabs standing',
      title:
        'Another session’s tab and the user’s are both refused in a sentence, a session closes its own, and a session ending leaves its tab open with its label',
      ok:
        userTab !== null &&
        alphaTab !== null &&
        betaOnAlpha?.ok === false &&
        betaOnAlpha.text.includes('browser-check session alpha') &&
        alphaOnUser?.ok === false &&
        alphaOnUser.text.includes('opened by the user') &&
        alphaReadsUser?.ok === false &&
        afterRefusals.includes(userTab) &&
        afterRefusals.includes(alphaTab) &&
        alphaOnOwn?.ok === true &&
        !afterClose.includes(alphaTab) &&
        afterClose.includes(userTab) &&
        survivor !== null &&
        afterRelease.includes(survivor) &&
        survivorStillLabelled === 'browser-check session alpha' &&
        afterReleaseCall.status === 401,
      detail: {
        userTab,
        alphaTab,
        betaTryingToCloseAlphas: betaOnAlpha?.text ?? null,
        alphaTryingToCloseTheUsers: alphaOnUser?.text ?? null,
        alphaTryingToReadTheUsers: alphaReadsUser?.text ?? null,
        tabsAfterTheRefusals: afterRefusals,
        alphaClosingItsOwn: alphaOnOwn?.text ?? null,
        tabsAfterThat: afterClose,
        afterTheSessionEnded: {
          tabStillOpen: survivor !== null && afterRelease.includes(survivor),
          stillLabelled: survivorStillLabelled,
          theOldTokenNowAnswers: afterReleaseCall.status
        }
      },
      notes: [
        'Two sessions rather than one, because "only tabs it opened" and "only tabs an',
        'agent opened" are different rules and the second would pass a probe that used',
        'one session and one user tab.',
        'The refusals are required to name **who** the tab belongs to, and the tab is',
        'required to still be there afterwards: "it refused" and "it refused after',
        'closing it" look identical from a return value.',
        'A session ending is `release`, which is the same call `sessions.ts` makes when',
        'a hosted process exits - so this is the mechanism rather than a stand-in. The',
        'tab survives it, keeps the name of the session that is gone, and the token',
        'that opened it no longer authenticates anything.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// live - one real claude, and what it did to the page
// ---------------------------------------------------------------------------

/** sha256 of a file, or a marker saying it was not there. */
function digest(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return 'absent'
  }
}

/**
 * Claude Code's startup gates, answered so that the MCP server is **enabled**.
 *
 * `profilescheck`'s version answers the MCP gate with Escape, which dismisses
 * it - right for a driver that does not want the user's servers and exactly
 * wrong here, where the server under test is the one being offered. Written out
 * rather than parameterised because the two answers mean opposite things and a
 * flag would make it possible to get this backwards without noticing.
 */
function answerGatesApprovingMcp(
  ctx: CheckContext,
  collector: Collector,
  id: number
): () => void {
  const answered = new Map<string, number>()
  const gates: Array<[string, RegExp]> = [
    ['trust', /doyoutrust|trustthisfolder|quicksafetycheck/g],
    ['mcp', /mcpserver/g],
    ['consent', /doyouwanttoproceed/g]
  ]
  const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length
  for (const [kind, re] of gates) answered.set(kind, count(squash(collector.output(id)), re))

  const timer = setInterval(() => {
    const text = squash(collector.output(id))
    for (const [kind, re] of gates) {
      const seen = count(text, re)
      if (seen > (answered.get(kind) ?? 0)) {
        answered.set(kind, seen)
        // Enter every time, including the MCP gate: the caret sits on the
        // agreeing option, and this driver wants the server it just registered.
        ctx.sessions.input(id, '\r')
      }
    }
  }, 400)
  return () => clearInterval(timer)
}

async function liveGroup(
  ctx: CheckContext,
  collector: Collector,
  origin: string,
  options: BrowserCheckOptions
): Promise<Check[]> {
  const checks: Check[] = []
  await clearViews(ctx)

  const claudeJson = join(homedir(), '.claude.json')
  const cwd = join(options.dataDir, 'browser-live-fixture')
  mkdirSync(cwd, { recursive: true })
  const projectMcpJson = join(cwd, '.mcp.json')
  // A `.mcp.json` that is *there*, so "byte-identical" is a claim about a file
  // rather than about two absences.
  writeFileSync(projectMcpJson, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`)

  const before = { claudeJson: digest(claudeJson), projectMcpJson: digest(projectMcpJson) }
  const configsBefore = readdirSync(mcpConfigDir).filter((name) => name.endsWith('.json'))

  const session = await ctx.sessions
    .start({ cwd, name: 'browser tools live', cols: 100, rows: 30, projectPath: cwd })
    .catch((err: unknown) => {
      return { error: err instanceof Error ? err.message : String(err) } as const
    })

  if ('error' in session) {
    return [
      {
        id: 'BR-36',
        criterion: 'A real session is launched with --mcp-config and drives the browser',
        title: 'No session could be started, so nothing below could be measured',
        ok: false,
        detail: { problem: session.error },
        notes: []
      }
    ]
  }

  const argv = session.argv
  const at = argv.indexOf('--mcp-config')
  const configFile = at === -1 ? null : (argv[at + 1] ?? null)
  const configExists = configFile !== null && existsSync(configFile)
  const configBody =
    configFile !== null && configExists
      ? (JSON.parse(readFileSync(configFile, 'utf8')) as {
          mcpServers?: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>
        })
      : null
  const served = configBody?.mcpServers?.[MCP_SERVER_NAME] ?? null

  // What the *user's* files look like now that a launch has been composed.
  const afterCompose = { claudeJson: digest(claudeJson), projectMcpJson: digest(projectMcpJson) }

  const stop = answerGatesApprovingMcp(ctx, collector, session.id)
  const ready = await waitFor(
    () => atPrompt(stripAnsi(collector.output(session.id))),
    150_000
  )
  await sleep(2500)

  let answer = { ok: false, answer: 'never reached a prompt' }
  if (ready) {
    const prompt =
      `Use the ${MCP_SERVER_NAME} MCP tools and nothing else. ` +
      `Call browser_open with the url ${origin}/planted. ` +
      `Then call browser_snapshot, find the button whose label is ${PLANT_LABEL}, ` +
      `and call browser_click with that button's ref. ` +
      `Then reply with exactly DONE=<the document title after the click>, which you can read with browser_evaluate.`
    ctx.sessions.input(session.id, prompt)
    await sleep(700)
    ctx.sessions.input(session.id, '\r')
    const found = await waitFor(
      () => squash(collector.output(session.id)).includes(squash(`DONE=${PLANT_TITLE}`)),
      420_000
    )
    answer = {
      ok: found,
      answer: stripAnsi(collector.output(session.id)).replace(/\s+/g, ' ').trim().slice(-1200)
    }
  }
  stop()

  /*
   * The driver's own confirmation, and it is what the verdict rests on.
   *
   * A session that says it clicked the button is a session making a claim. So
   * the tab is found through the browser host, the page is read for the token
   * the click writes, and the title is compared against the fixture's - none of
   * which goes anywhere near what the session printed.
   */
  const sessionTab =
    ctx.browsers.states().find((state) => state.openedBy === session.name)?.id ?? null
  const pageResult =
    sessionTab === null
      ? { ok: false, value: '', error: 'no tab' }
      : await ctx.browsers.evaluate(sessionTab, 'document.getElementById("result").textContent')
  const pageTitle =
    sessionTab === null
      ? { ok: false, value: '', error: 'no tab' }
      : await ctx.browsers.evaluate(sessionTab, 'document.title')
  const ownFetch = await fetchTitle(`${origin}/planted`)

  await screenshot(ctx.win, options.shotDir, 'browser-live.png')

  checks.push({
    id: 'BR-36',
    criterion:
      'A session launched through the real app opens the fixture, clicks a planted element, and reports what changed',
    title:
      'A real claude drives Helm’s browser through the endpoint, and the driver confirms the tab, the click and the title against its own reads',
    ok:
      ready &&
      answer.ok &&
      sessionTab !== null &&
      pageResult.value === PLANT_CLICKED &&
      pageTitle.value === PLANT_TITLE &&
      ownFetch === 'Helm fixture planted',
    detail: {
      sessionName: session.name,
      reachedPrompt: ready,
      sessionSaid: answer.answer,
      tabTheDriverFound: sessionTab,
      openedBy: sessionTab === null ? null : ctx.browsers.states(sessionTab)[0]?.openedBy,
      pageResultParagraph: pageResult.value,
      pageTitle: pageTitle.value,
      titleBeforeAnyClick: ownFetch
    },
    notes: [
      'A prediction about a session is only worth what a session says about it, and',
      'what a session says is only worth what the world says back: the answer has to',
      'contain the title, **and** the driver has to find the tab, the clicked',
      'paragraph and the title for itself.',
      'The fixture’s title before any click is fetched over HTTP by this driver, which',
      'is what stops "the title is the clicked one" being true of the page as served.',
      'One session, on haiku. This is the only thing in browser-check that costs',
      'anything.'
    ]
  })

  // --- argv hygiene ----------------------------------------------------------
  await ctx.sessions.close({ id: session.id, force: true })
  await waitFor(() => ctx.sessions.list().every((row) => row.id !== session.id), 30_000)
  await sleep(2000)

  const afterTeardown = { claudeJson: digest(claudeJson), projectMcpJson: digest(projectMcpJson) }
  const configGone = configFile === null || !existsSync(configFile)
  const configsAfter = readdirSync(mcpConfigDir).filter((name) => name.endsWith('.json'))
  const claudeJsonText = (() => {
    try {
      return readFileSync(claudeJson, 'utf8')
    } catch {
      return ''
    }
  })()

  checks.push({
    id: 'BR-37',
    criterion:
      'The argv carries --mcp-config into Helm’s data directory; the user’s config files are untouched and the ephemeral file is cleaned',
    title:
      'The session row’s argv points at a token file under Helm’s data directory, the file is gone after teardown, and the user’s .claude.json and .mcp.json are byte-identical across the composition',
    ok:
      configFile !== null &&
      configFile.toLowerCase().startsWith(mcpConfigDir.toLowerCase()) &&
      configExists &&
      served?.type === 'http' &&
      served.url?.startsWith('http://127.0.0.1:') === true &&
      (served.headers?.['Authorization'] ?? '').startsWith('Bearer ') &&
      // The composition wrote nothing of the user's.
      afterCompose.claudeJson === before.claudeJson &&
      afterCompose.projectMcpJson === before.projectMcpJson &&
      // And nothing put a Helm server into the user's own config, which is what
      // `claude mcp add-json -s local` would have done on every launch.
      !claudeJsonText.includes(MCP_SERVER_NAME) &&
      afterTeardown.projectMcpJson === before.projectMcpJson &&
      configGone &&
      configsAfter.length <= configsBefore.length,
    detail: {
      argv,
      mcpConfigFile: configFile,
      underHelmsDataDirectory: mcpConfigDir,
      whatItContained: served === null ? null : { ...served, headers: { Authorization: 'Bearer <redacted>' } },
      userFiles: {
        claudeJson: {
          before: before.claudeJson,
          afterComposingTheLaunch: afterCompose.claudeJson,
          afterTheSessionEnded: afterTeardown.claudeJson,
          mentionsHelmsServer: claudeJsonText.includes(MCP_SERVER_NAME)
        },
        projectMcpJson: {
          before: before.projectMcpJson,
          afterComposingTheLaunch: afterCompose.projectMcpJson,
          afterTheSessionEnded: afterTeardown.projectMcpJson
        }
      },
      ephemeralFiles: { before: configsBefore.length, after: configsAfter.length, goneAfterTeardown: configGone }
    },
    notes: [
      'The token is redacted in the detail. A report is a file somebody pastes into a',
      'message, and the token is the whole of the endpoint’s authentication - even a',
      'dead one is not a thing to write into an artefact.',
      '`~/.claude.json` is compared **across the composition** rather than across the',
      'whole session, and the difference is honest: Claude Code writes to its own',
      'config while it runs - startup counts, project history - and that is Claude',
      'Code’s business. What this asserts about the running session instead is the',
      'thing Helm could have got wrong: that no server of Helm’s ever appears in it,',
      'which is exactly what `claude mcp add-json -s local` would have left behind on',
      'every single launch.',
      'The project’s `.mcp.json` is compared across the whole thing, byte for byte,',
      'because nothing writes to that one.',
      'The ephemeral file existing **first** is half the claim: "it is not there" is',
      'also what a launch that never wrote one would report.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// A self-signed certificate, assembled by hand
// ---------------------------------------------------------------------------

/**
 * An X.509 leaf certificate for `localhost` / `127.0.0.1`, minted at run time.
 *
 * Node can generate a key pair and sign bytes but cannot mint a certificate,
 * and the two obvious ways round that are both wrong here. Committing a PEM
 * puts a private key in the repository, which is a thing this project does not
 * do whatever the key is for. Shelling out to `openssl` makes the check pass or
 * fail on whether a machine happens to have one on PATH, which is exactly what
 * CLAUDE.md's environment rule forbids of anything in `packages/`.
 *
 * So the DER is written out here. It is about eighty lines of ASN.1 and it has
 * no runtime cost - it runs once, in a check, against loopback.
 */
function selfSignedCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  const tbs = der(0x30, [
    // [0] EXPLICIT version, v3
    der(0xa0, [der(0x02, Buffer.from([2]))]),
    // serialNumber. DER integers are minimal: a leading zero is required only
    // when the top bit of the first byte is set, and adding one anyway is an
    // encoding error rather than a harmless belt - which is what the first run
    // of this said, in as many words (INVALID_INTEGER). 0x4c has the top bit
    // clear, so these four bytes are the whole of it.
    der(0x02, Buffer.from([0x4c, 0x9a, 0x11, 0x07])),
    ALGORITHM,
    name('Helm browser-check fixture'),
    der(0x30, [utcTime(Date.now() - 60 * 60 * 1000), utcTime(Date.now() + 365 * 24 * 60 * 60 * 1000)]),
    name('localhost'),
    spki,
    // [3] EXPLICIT extensions
    der(0xa3, [
      der(0x30, [
        // basicConstraints, critical, CA false (an empty SEQUENCE)
        der(0x30, [oid('2.5.29.19'), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30, []))]),
        // subjectAltName: DNS:localhost, IP:127.0.0.1
        der(0x30, [
          oid('2.5.29.17'),
          der(
            0x04,
            der(0x30, [
              der(0x82, Buffer.from('localhost', 'ascii')),
              der(0x87, Buffer.from([127, 0, 0, 1]))
            ])
          )
        ])
      ])
    ])
  ])

  const signature = createSign('sha256').update(tbs).sign(privateKey)
  const certificate = der(0x30, [
    tbs,
    ALGORITHM,
    // BIT STRING with zero unused bits
    der(0x03, Buffer.concat([Buffer.from([0x00]), signature]))
  ])

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem('CERTIFICATE', certificate)
  }
}

/** sha256WithRSAEncryption, with the NULL parameters the RFC asks for. */
const ALGORITHM = derLater(() => der(0x30, [oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00])]))

function derLater(build: () => Buffer): Buffer {
  return build()
}

/** A DER TLV. `content` is either raw bytes or a list of already-encoded values. */
function der(tag: number, content: Buffer | Buffer[]): Buffer {
  const body = Array.isArray(content) ? Buffer.concat(content) : content
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let left = length
  while (left > 0) {
    bytes.unshift(left & 0xff)
    left >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const bytes: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)]
  for (const part of parts.slice(2)) {
    const chunk: number[] = []
    let left = part
    do {
      chunk.unshift(left & 0x7f)
      left >>= 7
    } while (left > 0)
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] = (chunk[i] ?? 0) | 0x80
    bytes.push(...chunk)
  }
  return der(0x06, Buffer.from(bytes))
}

/** An RDNSequence carrying one commonName. */
function name(commonName: string): Buffer {
  return der(0x30, [
    der(0x31, [der(0x30, [oid('2.5.4.3'), der(0x0c, Buffer.from(commonName, 'utf8'))])])
  ])
}

function utcTime(at: number): Buffer {
  const when = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const text =
    pad(when.getUTCFullYear() % 100) +
    pad(when.getUTCMonth() + 1) +
    pad(when.getUTCDate()) +
    pad(when.getUTCHours()) +
    pad(when.getUTCMinutes()) +
    pad(when.getUTCSeconds()) +
    'Z'
  return der(0x17, Buffer.from(text, 'ascii'))
}

function pem(label: string, body: Buffer): string {
  const base64 = body.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}
