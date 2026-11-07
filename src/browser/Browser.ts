import rebrowser, { BrowserContext, type LaunchOptions } from 'patchright'
import { newInjectedContext } from 'fingerprint-injector'
import { BrowserFingerprintWithHeaders, FingerprintGenerator } from 'fingerprint-generator'

import type { MicrosoftRewardsBot } from '../index'
import { loadSession, saveFingerprint } from '../util/SessionStore'
import { fingerprintMatchesLocale } from '../util/Locale'
import { formatBrowserProxyServer } from '../util/Proxy'
import { resolveExitTimezone, timezoneOffsetMinutes } from '../util/ExitTimezone'
import { seededRandom, withMathRandom } from '../util/SeededRandom'
import { UserAgentManager } from './UserAgent'

import type { Account } from '../interface/Account'

/* Test Stuff
https://abrahamjuliot.github.io/creepjs/
https://botcheck.luminati.io/
https://fv.pro/
https://pixelscan.net/
https://www.browserscan.net/
*/

interface BrowserCreationResult {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

class Browser {
    private readonly bot: MicrosoftRewardsBot
    private static readonly BLOCKED_MEDIA_RESOURCE_TYPES = new Set(['image', 'media'])
    private static readonly BROWSER_ARGS = [
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-web-authentication-ui',
        '--disable-external-intent-requests',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=WebAuthentication,PasswordManagerOnboarding,PasswordManager,EnablePasswordsAccountStorage,Passkeys,WebAuthenticationProxy,U2F',
        '--disable-save-password-bubble',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
    ] as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async createBrowser(account: Account): Promise<BrowserCreationResult> {
        const headless = this.bot.config.headless

        // --no-proxy ignores the account proxy (e.g. a server-only socks5://localhost tunnel) for local one-off runs
        const noProxy = process.argv.includes('--no-proxy')
        if (noProxy && account.proxy.url) {
            this.bot.logger.warn(this.bot.isMobile, 'BROWSER', '--no-proxy set: connecting directly, ignoring account proxy')
        }
        const hasProxy = Boolean(account.proxy.url) && !noProxy
        const ignoreCertificateErrors = hasProxy && this.bot.config.proxy.ignoreCertificateErrors

        let browser: rebrowser.Browser
        try {
            const proxyConfig = hasProxy
                ? {
                      server: formatBrowserProxyServer(account.proxy.url, account.proxy.port),
                      ...(account.proxy.username &&
                          account.proxy.password && {
                              username: account.proxy.username,
                              password: account.proxy.password
                          })
                  }
                : undefined

            const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0
            const sandboxDisabled = process.platform === 'linux' && runningAsRoot
            const sandboxArgs = sandboxDisabled ? ['--no-sandbox', '--disable-setuid-sandbox'] : []

            const certArgs = ignoreCertificateErrors
                ? ['--ignore-certificate-errors', '--ignore-certificate-errors-spki-list', '--ignore-ssl-errors']
                : []

            if (ignoreCertificateErrors) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BROWSER-SECURITY',
                    'TLS certificate verification is disabled by proxy.ignoreCertificateErrors'
                )
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                `Launching bundled patched Chromium (Edge UA) | headless=${headless} | platform=${process.platform} | proxy=${hasProxy ? 'yes' : 'no'} | tls=${ignoreCertificateErrors ? 'verification-disabled' : 'verified'} | sandbox=${sandboxDisabled ? 'disabled-root' : 'enabled'}`
            )

            browser = await this.launch({
                headless,
                ...(proxyConfig && { proxy: proxyConfig }),
                args: [...Browser.BROWSER_ARGS, ...sandboxArgs, ...certArgs]
            })
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'BROWSER', `Browser launch failed: ${errorMessage}`)
            throw error
        }

        try {
            const session = loadSession(this.bot.config.sessionPath, account.email, this.bot.isMobile)

            if (session?.storageState) {
                const ageMinutes = Math.max(0, Math.floor((Date.now() - session.updatedAt) / 60000))
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SESSION',
                    `Restoring saved browser session | cookies=${session.storageState.cookies.length} | origins=${session.storageState.origins.length} | ageMinutes=${ageMinutes}`
                )
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SESSION',
                    'No saved browser session found; login may be required'
                )
            }

            const shouldUseFingerprint = this.bot.isMobile
                ? account.saveFingerprint.mobile
                : account.saveFingerprint.desktop

            const savedFingerprint = shouldUseFingerprint ? session?.fingerprint : null
            const reuseFingerprint =
                savedFingerprint && fingerprintMatchesLocale(savedFingerprint, this.bot.accountLocale)

            if (savedFingerprint && !reuseFingerprint) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'BROWSER-FINGERPRINT',
                    `Saved fingerprint locale does not match ${this.bot.accountLocale.locale}; generating a replacement`
                )
            }

            // Same account -> same device every run, instead of a brand-new one each day
            const deviceSeed = `${account.email.trim().toLowerCase()}|${this.bot.isMobile ? 'mobile' : 'desktop'}`
            const fingerprint =
                (reuseFingerprint && savedFingerprint) ||
                (await this.generateFingerprint(this.bot.isMobile, deviceSeed))

            // The browser clock follows the exit IP, not the server (GitHub runners are UTC)
            const proxyKey = hasProxy ? formatBrowserProxyServer(account.proxy.url, account.proxy.port) : 'direct'
            const timezoneId = await resolveExitTimezone(browser, proxyKey)
            if (timezoneId) {
                this.bot.userData.timezoneOffset = String(timezoneOffsetMinutes(timezoneId))
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BROWSER',
                    'Could not look up the exit IP timezone - keeping the host clock'
                )
            }

            const screen = fingerprint.fingerprint.screen

            // @ts-ignore It doesn't like the browser instance from different packages
            const injected = await newInjectedContext(browser, {
                fingerprint,
                newContextOptions: {
                    permissions: [],
                    ignoreHTTPSErrors: ignoreCertificateErrors,
                    ...(timezoneId ? { timezoneId } : {}),
                    // Restore cookies
                    ...(session?.storageState ? { storageState: session.storageState } : {}),
                    ...(this.bot.isMobile
                        ? {
                              isMobile: true,
                              hasTouch: true,
                              deviceScaleFactor: screen.devicePixelRatio,
                              viewport: { width: screen.width, height: screen.height },
                              screen: { width: screen.width, height: screen.height }
                          }
                        : {})
                }
            })
            const context = injected as unknown as BrowserContext

            // Only alter WebRTC when a proxy is in use. Removing these APIs on direct connections
            // adds an unnecessary fingerprint difference; behind a proxy it prevents local/direct
            // ICE candidates from exposing an address outside the configured proxy path.
            if (hasProxy) {
                await context.addInitScript(() => {
                    // @ts-expect-error Chromium-specific runtime globals
                    delete window.RTCPeerConnection
                    // @ts-expect-error Legacy Chromium runtime global
                    delete window.webkitRTCPeerConnection
                    // @ts-expect-error Chromium-specific runtime global
                    delete window.RTCDataChannel
                })
            }

            await this.configureMediaBlocking(context)

            context.on('page', p => {
                p.on('crash', () =>
                    this.bot.logger.error(this.bot.isMobile, 'BROWSER', `Renderer crashed | ${p.url()}`)
                )
            })
            context.on('close', () => this.bot.logger.warn(this.bot.isMobile, 'BROWSER', 'Browser context closed'))

            context.setDefaultTimeout(this.bot.utils.stringToNumber(this.bot.config?.globalTimeout ?? 30000))

            if (shouldUseFingerprint) {
                saveFingerprint(this.bot.config.sessionPath, account.email, this.bot.isMobile, fingerprint)
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                `Created context | locale=${this.bot.accountLocale.locale} | timezone=${timezoneId ?? 'host'} | Accept-Language="${this.bot.accountLocale.acceptLanguage}" | User-Agent: "${fingerprint.fingerprint.navigator.userAgent}"`
            )
            this.bot.logger.debug(this.bot.isMobile, 'BROWSER-FINGERPRINT', JSON.stringify(fingerprint))

            return { context, fingerprint }
        } catch (error) {
            await browser.close().catch(() => {})
            throw error
        }
    }

    private async configureMediaBlocking(context: BrowserContext): Promise<void> {
        if (!this.bot.config.experimental.blockMedia) return

        await context.route('**/*', async route => {
            const resourceType = route.request().resourceType()
            if (Browser.BLOCKED_MEDIA_RESOURCE_TYPES.has(resourceType)) {
                await route.abort()
                return
            }

            // Fall through instead of continuing directly so fingerprint-injector or
            // future context-level route handlers still get a chance to process it.
            await route.fallback()
        })

        this.bot.logger.info(
            this.bot.isMobile,
            'BROWSER',
            'Media loading disabled | blockedResourceTypes=image,media | httpCache=disabled-by-routing'
        )
    }

    // headless:true on its own runs chromium-headless-shell, the old headless build that bot checks
    // single out easily. The full Chromium build in new headless mode looks like a normal browser.
    private async launch(options: LaunchOptions): Promise<rebrowser.Browser> {
        if (!options.headless) return rebrowser.chromium.launch(options)
        try {
            return await rebrowser.chromium.launch({ ...options, channel: 'chromium' })
        } catch (error) {
            const reason = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
            this.bot.logger.warn(
                this.bot.isMobile,
                'BROWSER',
                `Full Chromium not available for new headless mode - using the headless shell | ${reason}`
            )
            return rebrowser.chromium.launch(options)
        }
    }

    /**
     * With a `seed` the result is the same device every time (hardware, screen, phone model, OS
     * version); only the browser version follows real Edge releases. Without one it is random.
     */
    async generateFingerprint(isMobile: boolean, seed?: string): Promise<BrowserFingerprintWithHeaders> {
        const hostOs: 'windows' | 'macos' | 'linux' =
            process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : 'windows'

        const generate = () =>
            new FingerprintGenerator().getFingerprint({
                devices: isMobile ? ['mobile'] : ['desktop'],
                operatingSystems: isMobile ? ['android'] : [hostOs],
                browsers: [{ name: 'edge' }],
                locales: this.bot.accountLocale.acceptedLocales
            })

        // fingerprint-generator takes no seed, so its Math.random is swapped for the call (it is synchronous)
        const fingerPrintData = seed ? withMathRandom(seededRandom(`${seed}|fingerprint`), generate) : generate()

        const userAgentManager = new UserAgentManager(this.bot)
        return await userAgentManager.updateFingerprintUserAgent(
            fingerPrintData,
            isMobile,
            seed ? seededRandom(`${seed}|user-agent`) : Math.random
        )
    }
}

export default Browser
