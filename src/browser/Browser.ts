import playwright, { BrowserContext } from 'rebrowser-playwright'

import { newInjectedContext } from 'fingerprint-injector'
import { FingerprintGenerator } from 'fingerprint-generator'

import { MicrosoftRewardsBot } from '../index'
import { loadSessionData, saveFingerprintData } from '../util/Load'
import { updateFingerprintUserAgent } from '../util/UserAgent'

import { AccountProxy } from '../interface/Account'

/**
 * Enhanced Browser factory with humanization, fingerprint diversity and safer proxy handling.
 */
class Browser {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async createBrowser(proxy: AccountProxy, email: string): Promise<BrowserContext> {
        // allow automatic playwright installation if requested
        if (process.env.AUTO_INSTALL_BROWSERS === '1') {
            try {
                const { execSync } = await import('child_process')
                execSync('npx playwright install chromium', { stdio: 'ignore' })
            } catch { /* silent */ }
        }

        const cfgAny = this.bot.config as unknown as Record<string, unknown>

        // small human-like pause before starting setup
        try { await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900)) } catch { /* ignore */ }

        // Retry logic for launching browser (exponential backoff)
        const maxLaunchAttempts = 3
        let launchErr: unknown
        let launched: import('rebrowser-playwright').Browser | undefined = undefined

        for (let attempt = 1; attempt <= maxLaunchAttempts; attempt++) {
            try {
                const envForceHeadless = process.env.FORCE_HEADLESS === '1'
                const headlessValue = envForceHeadless
                    ? true
                    : ((cfgAny['headless'] as boolean | undefined)
                        ?? (cfgAny['browser'] && (cfgAny['browser'] as Record<string, unknown>)['headless'] as boolean | undefined)
                        ?? false)
                const headless: boolean = Boolean(headlessValue)

                // slowMo to simulate human input speed; randomized a bit
                const slowMo = (this.bot.utils && typeof this.bot.utils.randomNumber === 'function')
                    ? this.bot.utils.randomNumber(50, 150)
                    : Math.floor(Math.random() * 100) + 50

                const launchOpts: any = {
                    headless,
                    slowMo,
                    args: [
                        '--no-sandbox',
                        '--mute-audio',
                        '--disable-setuid-sandbox',
                        '--ignore-certificate-errors',
                        '--disable-blink-features=AutomationControlled',
                        `--window-size=${1280 + Math.floor(Math.random() * 200)},${720 + Math.floor(Math.random() * 120)}`
                    ]
                }

                // REMOVED PROXY PROBABILITY - always use proxy if available
                if (proxy && proxy.url) {
                    // Normalize proxy.server as host:port (Playwright expects server string)
                    const server = proxy.port ? `${proxy.url}:${proxy.port}` : proxy.url
                    launchOpts.proxy = {
                        server,
                        username: proxy.username,
                        password: proxy.password
                    }
                    this.bot.log(this.bot.isMobile, 'BROWSER', `Using proxy for launch. Server=${server}`)
                }

                launched = await playwright.chromium.launch(launchOpts)
                launchErr = undefined
                break
            } catch (e: unknown) {
                launchErr = e
                const waitMs = Math.min(15000, Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 500))
                this.bot.log(this.bot.isMobile, 'BROWSER', `Launch attempt ${attempt} failed: ${(e instanceof Error) ? e.message : String(e)}. Retrying after ${waitMs}ms`, 'warn')
                try { await this.bot.utils.wait(waitMs) } catch { /* ignore */ }
            }
        }

        if (!launched) {
            const msg = (launchErr instanceof Error ? launchErr.message : String(launchErr))
            this.bot.log(this.bot.isMobile, 'BROWSER', `Failed to launch browser after ${maxLaunchAttempts} attempts: ${msg}`, 'error')
            throw launchErr
        }

        const browser = launched as import('rebrowser-playwright').Browser

        // --- Normalize saveFingerprint config ---
        const rawFp = (cfgAny['saveFingerprint']
            ?? (cfgAny['fingerprinting'] as Record<string, unknown> | undefined)?.['saveFingerprint']) as unknown

        const saveFingerprintForLoad: { mobile: boolean; desktop: boolean } =
            typeof rawFp === 'boolean'
                ? { mobile: rawFp, desktop: rawFp }
                : {
                    mobile: !!(rawFp && (rawFp as Record<string, unknown>)['mobile']),
                    desktop: !!(rawFp && (rawFp as Record<string, unknown>)['desktop'])
                }

        // --- Load session with normalized config ---
        const sessionData = await loadSessionData(
            this.bot.config.sessionPath,
            email,
            this.bot.isMobile,
            saveFingerprintForLoad
        )

        // fingerprint: use persisted one if available; otherwise generate
        const fingerprint = sessionData.fingerprint
            ? sessionData.fingerprint
            : await this.generateFingerprint()

        // update UA string inside fingerprint to reflect any local overrides
        const finalFingerprint = await updateFingerprintUserAgent(fingerprint, this.bot.isMobile)

        // Create injected context with fingerprint
        const context = await newInjectedContext(
            browser as unknown as import('playwright').Browser,
            { fingerprint: finalFingerprint }
        )

        // set a sane global timeout (configurable)
        const globalTimeout = (cfgAny['globalTimeout'] as unknown)
            ?? ((cfgAny['browser'] as Record<string, unknown> | undefined)?.['globalTimeout'] as unknown)
            ?? 30000
        try {
            context.setDefaultTimeout(this.bot.utils.stringToMs(globalTimeout as (number | string)))
        } catch { /* ignore */ }

        // Randomized base viewports (vary slightly between page creations)
        const baseDesktopViewport = { width: 1280 + Math.floor(Math.random() * 200), height: 720 + Math.floor(Math.random() * 120) }
        const baseMobileViewport = { width: 360 + Math.floor(Math.random() * 60), height: 800 + Math.floor(Math.random() * 120) }

        // On new page, apply per-page randomized viewport + init script for slight UI variation
        context.on('page', async (page) => {
            try {
                const viewport = this.bot.isMobile ? baseMobileViewport : baseDesktopViewport
                // per-page jitter
                const jitterViewport = {
                    width: Math.max(320, viewport.width + Math.floor((Math.random() - 0.5) * 100)),
                    height: Math.max(480, viewport.height + Math.floor((Math.random() - 0.5) * 100))
                }

                try { await page.setViewportSize(jitterViewport) } catch { /* ignore */ }

                // Add a tiny init script to vary rendering and occasionally simulate a tiny human correction scroll
                await page.addInitScript(() => {
                    try {
                        // randomized CSS zoom to vary rendering slightly
                        const s = document.createElement('style')
                        s.id = '__mrs_variation_style'
                        const zoom = (0.85 + Math.random() * 0.25).toFixed(2)
                        s.textContent = `html { zoom: ${zoom} !important; } html, body { overscroll-behavior: contain; }`
                        document.documentElement.appendChild(s)

                        // occasionally do a very small scroll/restore to mimic a user touch
                        if (Math.random() < 0.1) {
                            setTimeout(() => { try { window.scrollBy(0, 40); setTimeout(() => window.scrollBy(0, -40), 250); } catch { } }, 200)
                        }
                    } catch { /* ignore */ }
                })

                // set some headers per-context (locale/timezone may be reflected in bot.config.geoLocale)
                try {
                    const headers: Record<string, string> = {}
                    headers['Accept-Language'] = (this.bot.config?.geoLocale?.locale) || 'en-US,en;q=0.9'
                    headers['DNT'] = Math.random() < 0.8 ? '1' : '0'
                    try { await page.context().setExtraHTTPHeaders(headers) } catch { /* ignore */ }
                } catch { /* ignore */ }

            } catch (err) {
                this.bot.log(this.bot.isMobile, 'BROWSER', `page init handling failed: ${(err instanceof Error) ? err.message : String(err)}`, 'warn')
            }
        })

        // restore cookies (if any)
        try {
            await context.addCookies(sessionData.cookies || [])
            // small pause after cookies restored
            try { await this.bot.utils.wait(this.bot.utils.randomNumber(200, 600)) } catch { }
        } catch (e) {
            this.bot.log(this.bot.isMobile, 'BROWSER', `Failed to restore cookies: ${(e instanceof Error) ? e.message : String(e)}`, 'warn')
        }

        // Persist fingerprint if configured
        const shouldPersistFingerprint = this.bot.isMobile
            ? saveFingerprintForLoad.mobile
            : saveFingerprintForLoad.desktop

        if (shouldPersistFingerprint) {
            try {
                await saveFingerprintData(this.bot.config.sessionPath, email, this.bot.isMobile, finalFingerprint)
                try { await this.bot.utils.wait(this.bot.utils.randomNumber(100, 300)) } catch { }
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'BROWSER', `Failed to persist fingerprint: ${(e instanceof Error) ? e.message : String(e)}`, 'warn')
            }
        }

        this.bot.log(this.bot.isMobile, 'BROWSER', `Created browser context. User-Agent: "${finalFingerprint.fingerprint.navigator.userAgent}"`)

        return context as unknown as BrowserContext
    }

    async generateFingerprint() {
        // Introduce diversity in generated fingerprints
        const osOptions: Array<'android' | 'ios' | 'windows' | 'macos' | 'linux'> = this.bot.isMobile
            ? ['android', 'ios']
            : ['windows', 'macos', 'linux']
        const browserOptions: Array<'edge' | 'chrome' | 'firefox' | 'safari'> = ['edge', 'chrome', 'firefox']
        const screenOptions = this.bot.isMobile
            ? [{ width: 360, height: 780 }, { width: 375, height: 812 }, { width: 412, height: 915 }]
            : [{ width: 1280, height: 800 }, { width: 1366, height: 768 }, { width: 1536, height: 864 }]

        // Use nullish coalescing operator to ensure values are never undefined
        const osChoice = osOptions[Math.floor(Math.random() * osOptions.length)] ?? (this.bot.isMobile ? 'android' : 'windows');
        const browserChoice = browserOptions[Math.floor(Math.random() * browserOptions.length)] ?? 'edge';
        const screenChoice = screenOptions[Math.floor(Math.random() * screenOptions.length)] ?? screenOptions[0];

        const fg = new FingerprintGenerator()
        // FingerprintGenerator expects screen range object; convert width/height to range shape
        const screenRange = screenChoice ? {
            minWidth: screenChoice.width,
            maxWidth: screenChoice.width,
            minHeight: screenChoice.height,
            maxHeight: screenChoice.height
        } : undefined

        const fp = fg.getFingerprint({
            devices: this.bot.isMobile ? ['mobile'] : ['desktop'],
            operatingSystems: [osChoice],
            browsers: [{ name: browserChoice }],
            screen: screenRange
        })

        try {
            const updated = await updateFingerprintUserAgent(fp, this.bot.isMobile)
            return updated
        } catch (e) {
            // fallback: return original fingerprint
            return fp
        }
    }
}

export default Browser