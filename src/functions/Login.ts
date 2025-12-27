import { generateTOTP } from '../util/Totp'
import playwright, { Page } from 'rebrowser-playwright'
import readline from 'readline'
import * as crypto from 'crypto'
import { AxiosRequestConfig } from 'axios'

import { MicrosoftRewardsBot } from '../index'
import { saveSessionData } from '../util/Load'
import { captureDiagnostics } from '../util/Diagnostics'

import { OAuth } from '../interface/OAuth'

export interface LoginErrorEvent {
    type: 'MOBILE_AUTH_FAILED' | 'LOGIN_FAILED' | 'ACCOUNT_LOCKED';
    email: string;
    message: string;
    retryAfterMs?: number;
    shouldRestartBrowsers?: boolean;
}

// Security pattern bundle
const SIGN_IN_BLOCK_PATTERNS: { re: RegExp; label: string }[] = [
    { re: /we can[''`]?t sign you in/i, label: 'cant-sign-in' },
    { re: /incorrect account or password too many times/i, label: 'too-many-incorrect' },
    { re: /used an incorrect account or password too many times/i, label: 'too-many-incorrect-variant' },
    { re: /sign-in has been blocked/i, label: 'sign-in-blocked-phrase' },
    { re: /your account has been locked/i, label: 'account-locked' },
    { re: /your account or password is incorrect too many times/i, label: 'incorrect-too-many-times' }
]

interface SecurityIncident {
    kind: string
    account: string
    details?: string[]
    next?: string[]
    docsUrl?: string
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

// Constants
const SELECTORS = {
    emailInput: 'input[type="email"]',
    passwordInput: 'input[type="password"]',
    submitBtn: 'button[type="submit"]',
    passkeySecondary: 'button[data-testid="secondaryButton"]',
    passkeyPrimary: 'button[data-testid="primaryButton"]',
    passkeyTitle: '[data-testid="title"]',
    kmsiVideo: '[data-testid="kmsiVideo"]',
    biometricVideo: '[data-testid="biometricVideo"]'
} as const

// Default wait time after sending verification email (ms).
const DEFAULT_EMAIL_WAIT_MS = 4000
const DEFAULT_GMAIL_NAV_WAIT_MS = 2500
const DEFAULT_PASSWORD_FILL_DELAY_MS = 600

// Wait 3-4 minutes before checking Gmail to allow delivery
const MIN_EMAIL_WAIT_BEFORE_FETCH_MS = 9.5 * 60 * 1000
const MAX_EMAIL_WAIT_BEFORE_FETCH_MS = 10 * 60 * 1000

// Backoff wait range (10-15 minutes) between full-login retries
const MIN_RETRY_BACKOFF_MS = 10 * 60 * 1000
const MAX_RETRY_BACKOFF_MS = 15 * 60 * 1000

export class Login {
    private bot: MicrosoftRewardsBot
    private clientId: string = '0000000040170455'
    private authBaseUrl: string = 'https://login.live.com/oauth20_authorize.srf'
    private redirectUrl: string = 'https://login.live.com/oauth20_desktop.srf'
    private tokenUrl: string = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
    private scope: string = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'

    // Add TOTP support
    private currentTotpSecret?: string

    // Add error event emitter
    private errorCallbacks: ((error: LoginErrorEvent) => void)[] = []

    // Security incident tracking
    private compromisedInterval?: NodeJS.Timeout
    private passkeyHandled = false
    private noPromptIterations = 0
    private lastNoPromptLog = 0

    // Unified TOTP selector system
    private static readonly TOTP_SELECTORS = {
        input: [
            'input[name="otc"]',
            '#idTxtBx_SAOTCC_OTC',
            '#idTxtBx_SAOTCS_OTC',
            'input[data-testid="otcInput"]',
            'input[autocomplete="one-time-code"]',
            'input[type="tel"][name="otc"]'
        ],
        altOptions: [
            '#idA_SAOTCS_ProofPickerChange',
            '#idA_SAOTCC_AlternateLogin',
            'a:has-text("Use a different verification option")',
            'a:has-text("Sign in another way")',
            'a:has-text("I can\'t use my Microsoft Authenticator app right now")',
            'button:has-text("Use a different verification option")',
            'button:has-text("Sign in another way")'
        ],
        challenge: [
            '[data-value="PhoneAppOTP"]',
            '[data-value="OneTimeCode"]',
            'button:has-text("Use a verification code")',
            'button:has-text("Enter code manually")',
            'button:has-text("Enter a code from your authenticator app")',
            'button:has-text("Use code from your authentication app")',
            'button:has-text("Utiliser un code de vérification")',
            'button:has-text("Utiliser un code de verification")',
            'button:has-text("Entrer un code depuis votre application")',
            'button:has-text("Entrez un code depuis votre application")',
            'button:has-text("Entrez un code")',
            'div[role="button"]:has-text("Use a verification code")',
            'div[role="button"]:has-text("Enter a code")'
        ],
        submit: [
            '#idSubmit_SAOTCC_Continue',
            '#idSubmit_SAOTCC_OTC',
            'button[type="submit"]:has-text("Verify")',
            'button[type="submit"]:has-text("Continuer")',
            'button:has-text("Verify")',
            'button:has-text("Continuer")',
            'button:has-text("Submit")'
        ]
    } as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    // Method to register error callbacks
    onError(callback: (error: LoginErrorEvent) => void) {
        this.errorCallbacks.push(callback)
    }

    // Method to emit errors
    private emitError(error: LoginErrorEvent) {
        this.errorCallbacks.forEach(callback => {
            try {
                callback(error)
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'LOGIN-ERROR', `Error in error callback: ${e}`, 'error')
            }
        })
    }

    // --------------- Enhanced Security Methods from Main Branch ---------------
    private async detectSignInBlocked(page: Page): Promise<boolean> {
        if (this.bot.compromisedModeActive && this.bot.compromisedReason === 'sign-in-blocked') return true
        try {
            let text = ''
            for (const sel of ['[data-testid="title"]','h1','div[role="heading"]','div.text-title']) {
                const el = await page.waitForSelector(sel, { timeout: 600 }).catch(()=>null)
                if (el) {
                    const t = (await el.textContent()||'').trim()
                    if (t && t.length < 300) text += ' '+t
                }
            }
            const lower = text.toLowerCase()
            let matched: string | null = null
            for (const p of SIGN_IN_BLOCK_PATTERNS) { if (p.re.test(lower)) { matched = p.label; break } }
            if (!matched) return false
            const email = this.bot.currentAccountEmail || 'unknown'
            const docsUrl = this.getDocsUrl('we-cant-sign-you-in')
            const incident: SecurityIncident = {
                kind: 'We can\'t sign you in (blocked)',
                account: email,
                details: [matched ? `Pattern: ${matched}` : 'Pattern: unknown'],
                next: ['Manual recovery required before continuing'],
                docsUrl
            }
            await this.sendIncidentAlert(incident,'warn')
            this.bot.compromisedModeActive = true
            this.bot.compromisedReason = 'sign-in-blocked'
            this.startCompromisedInterval()
            await this.bot.engageGlobalStandby('sign-in-blocked', email).catch(()=>{})
            await this.saveIncidentArtifacts(page,'sign-in-blocked').catch(()=>{})
            // Open security docs for immediate guidance (best-effort)
            await this.openDocsTab(page, docsUrl).catch(()=>{})
            return true
        } catch { return false }
    }

    private async detectAndHandleRecoveryMismatch(page: Page, email: string) {
        try {
            const recoveryEmail: string | undefined = this.bot.currentAccountRecoveryEmail
            if (!recoveryEmail || !/@/.test(recoveryEmail)) return
            const accountEmail = email
            const parseRef = (val: string) => { const [l,d] = val.split('@'); return { local: l||'', domain:(d||'').toLowerCase(), prefix2:(l||'').slice(0,2).toLowerCase() } }
            const refs = [parseRef(recoveryEmail), parseRef(accountEmail)].filter(r=>r.domain && r.prefix2)
            if (refs.length === 0) return

            const candidates: string[] = []
            // Direct selectors (Microsoft variants + French spans)
            const sel = '[data-testid="recoveryEmailHint"], #recoveryEmail, [id*="ProofEmail"], [id*="EmailProof"], [data-testid*="Email"], span:has(span.fui-Text)'
            const el = await page.waitForSelector(sel, { timeout: 1500 }).catch(()=>null)
            if (el) { const t = (await el.textContent()||'').trim(); if (t) candidates.push(t) }

            // List items
            const li = page.locator('[role="listitem"], li')
            const liCount = await li.count().catch(()=>0)
            for (let i=0;i<liCount && i<12;i++) { const t = (await li.nth(i).textContent().catch(()=>''))?.trim()||''; if (t && /@/.test(t)) candidates.push(t) }

            // XPath generic masked patterns
            const xp = page.locator('xpath=//*[contains(normalize-space(.), "@") and (contains(normalize-space(.), "*") or contains(normalize-space(.), "•"))]')
            const xpCount = await xp.count().catch(()=>0)
            for (let i=0;i<xpCount && i<12;i++) { const t = (await xp.nth(i).textContent().catch(()=>''))?.trim()||''; if (t && t.length<300) candidates.push(t) }

            // Normalize
            const seen = new Set<string>()
            const norm = (s:string)=>s.replace(/\s+/g,' ').trim()
            const uniq = candidates.map(norm).filter(t=>t && !seen.has(t) && seen.add(t))
            // Masked filter
            let masked = uniq.filter(t=>/@/.test(t) && /[*•]/.test(t))

            if (masked.length === 0) {
                // Fallback full HTML scan
                try {
                    const html = await page.content()
                    const generic = /[A-Za-z0-9]{1,4}[*•]{2,}[A-Za-z0-9*•._-]*@[A-Za-z0-9.-]+/g
                    const frPhrase = /Nous\s+enverrons\s+un\s+code\s+à\s+([^<@]*[A-Za-z0-9]{1,4}[*•]{2,}[A-Za-z0-9*•._-]*@[A-Za-z0-9.-]+)[^.]{0,120}?Pour\s+vérifier/gi
                    const found = new Set<string>()
                    let m: RegExpExecArray | null
                    while ((m = generic.exec(html)) !== null) found.add(m[0])
                    while ((m = frPhrase.exec(html)) !== null) { const raw = m[1]?.replace(/<[^>]+>/g,'').trim(); if (raw) found.add(raw) }
                    if (found.size > 0) masked = Array.from(found)
                } catch {/* ignore */}
            }
            if (masked.length === 0) return

            // Prefer one mentioning email/adresse
            const preferred = masked.find(t=>/email|courriel|adresse|mail/i.test(t)) || masked[0]!
            // Extract the masked email: Microsoft sometimes shows only first 1 char (k*****@domain) or 2 chars (ko*****@domain).
            // We ONLY compare (1 or 2) leading visible alphanumeric chars + full domain (case-insensitive).
            // This avoids false positives when the displayed mask hides the 2nd char.
            const maskRegex = /([a-zA-Z0-9]{1,2})[a-zA-Z0-9*•._-]*@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/
            const m = maskRegex.exec(preferred)
            // Fallback: try to salvage with looser pattern if first regex fails
            const loose = !m ? /([a-zA-Z0-9])[*•][a-zA-Z0-9*•._-]*@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/.exec(preferred) : null
            const use = m || loose
            const extracted = use ? use[0] : preferred
            const extractedLower = extracted.toLowerCase()
            let observedPrefix = ((use && use[1]) ? use[1] : '').toLowerCase()
            let observedDomain = ((use && use[2]) ? use[2] : '').toLowerCase()
            if (!observedDomain && extractedLower.includes('@')) {
                const parts = extractedLower.split('@')
                observedDomain = parts[1] || ''
            }
            if (!observedPrefix && extractedLower.includes('@')) {
                const parts = extractedLower.split('@')
                observedPrefix = (parts[0] || '').replace(/[^a-z0-9]/gi,'').slice(0,2)
            }

            // Determine if any reference (recoveryEmail or accountEmail) matches observed mask logic
            const matchRef = refs.find(r => {
                if (r.domain !== observedDomain) return false
                // If only one char visible, only enforce first char; if two, enforce both.
                if (observedPrefix.length === 1) {
                    return r.prefix2.startsWith(observedPrefix)
                }
                return r.prefix2 === observedPrefix
            })

            if (!matchRef) {
                const docsUrl = this.getDocsUrl('recovery-email-mismatch')
                const incident: SecurityIncident = {
                    kind:'Recovery email mismatch',
                    account: email,
                    details:[
                        `MaskedShown: ${preferred}`,
                        `Extracted: ${extracted}`,
                        `Observed => ${observedPrefix || '??'}**@${observedDomain || '??'}`,
                        `Expected => ${refs.map(r=>`${r.prefix2}**@${r.domain}`).join(' OR ')}`
                    ],
                    next:[
                        'Automation halted globally (standby engaged).',
                        'Verify account security & recovery email in Microsoft settings.',
                        'Update accounts.json if the change was legitimate before restart.'
                    ],
                    docsUrl
                }
                await this.sendIncidentAlert(incident,'critical')
                this.bot.compromisedModeActive = true
                this.bot.compromisedReason = 'recovery-mismatch'
                this.startCompromisedInterval()
                await this.bot.engageGlobalStandby('recovery-mismatch', email).catch(()=>{})
                await this.saveIncidentArtifacts(page,'recovery-mismatch').catch(()=>{})
                await this.openDocsTab(page, docsUrl).catch(()=>{})
            } else {
                const mode = observedPrefix.length === 1 ? 'lenient' : 'strict'
                this.bot.log(this.bot.isMobile,'LOGIN-RECOVERY',`Recovery OK (${mode}): ${extracted} matches ${matchRef.prefix2}**@${matchRef.domain}`)
            }
        } catch {/* non-fatal */}
    }

    private async tryRecoveryMismatchCheck(page: Page, email: string) {
        try { await this.detectAndHandleRecoveryMismatch(page, email) } catch {/* ignore */}
    }

    private async switchToPasswordLink(page: Page) {
        try {
            const link = await page.locator('xpath=//span[@role="button" and (contains(translate(normalize-space(.),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"use your password") or contains(translate(normalize-space(.),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"utilisez votre mot de passe"))]').first()
            if (await link.isVisible().catch(()=>false)) {
                await link.click().catch(()=>{})
                await this.bot.utils.wait(800)
                this.bot.log(this.bot.isMobile,'LOGIN','Clicked "Use your password" link')
            }
        } catch {/* ignore */}
    }

    // --------------- Incident Helpers ---------------
    private async sendIncidentAlert(incident: SecurityIncident, severity: 'warn'|'critical'='warn') {
        const lines = [ `[Incident] ${incident.kind}`, `Account: ${incident.account}` ]
        if (incident.details?.length) lines.push(`Details: ${incident.details.join(' | ')}`)
        if (incident.next?.length) lines.push(`Next: ${incident.next.join(' -> ')}`)
        if (incident.docsUrl) lines.push(`Docs: ${incident.docsUrl}`)
        const level: 'warn'|'error' = severity === 'critical' ? 'error' : 'warn'
        this.bot.log(this.bot.isMobile,'SECURITY',lines.join(' | '), level)
        try {
            const { ConclusionWebhook } = await import('../util/ConclusionWebhook')
            const fields = [
                { name: 'Account', value: incident.account },
                ...(incident.details?.length ? [{ name: 'Details', value: incident.details.join('\n') }] : []),
                ...(incident.next?.length ? [{ name: 'Next steps', value: incident.next.join('\n') }] : []),
                ...(incident.docsUrl ? [{ name: 'Docs', value: incident.docsUrl }] : [])
            ]
            await ConclusionWebhook(
                this.bot.config,
                `🔐 ${incident.kind}`,
                '_Security check by @Light_',
                fields,
                severity === 'critical' ? 0xFF0000 : 0xFFAA00
            )
        } catch {/* ignore */}
    }

    private getDocsUrl(anchor?: string) {
        const base = process.env.DOCS_BASE?.trim() || 'https://github.com/LightZirconite/Microsoft-Rewards-Script-Private/blob/v2/docs/security.md'
        const map: Record<string,string> = {
            'recovery-email-mismatch':'#recovery-email-mismatch',
            'we-cant-sign-you-in':'#we-cant-sign-you-in-blocked'
        }
        return anchor && map[anchor] ? `${base}${map[anchor]}` : base
    }

    private startCompromisedInterval() {
        if (this.compromisedInterval) clearInterval(this.compromisedInterval)
        this.compromisedInterval = setInterval(()=>{
            try { this.bot.log(this.bot.isMobile,'SECURITY','Account in security standby. Review before proceeding. Security check by @Light','warn') } catch {/* ignore */}
        }, 5*60*1000)
    }

    private async saveIncidentArtifacts(page: Page, slug: string) {
        await captureDiagnostics(this.bot, page, slug, { scope: 'security', skipSlot: true, force: true })
    }

    private async openDocsTab(page: Page, url: string) {
        try {
            const ctx = page.context()
            const tab = await ctx.newPage()
            await tab.goto(url, { waitUntil: 'domcontentloaded' })
        } catch {/* ignore */}
    }

    // --------------- Enhanced TOTP Methods from Main Branch ---------------
    private totpInputSelectors(): readonly string[] { return Login.TOTP_SELECTORS.input }
    private totpAltOptionSelectors(): readonly string[] { return Login.TOTP_SELECTORS.altOptions }
    private totpChallengeSelectors(): readonly string[] { return Login.TOTP_SELECTORS.challenge }

    private async findFirstVisibleSelector(page: Page, selectors: readonly string[]): Promise<string | null> {
        for (const sel of selectors) {
            const loc = page.locator(sel).first()
            if (await loc.isVisible().catch(() => false)) return sel
        }
        return null
    }

    private async clickFirstVisibleSelector(page: Page, selectors: readonly string[]): Promise<boolean> {
        for (const sel of selectors) {
            const loc = page.locator(sel).first()
            if (await loc.isVisible().catch(() => false)) {
                await loc.click().catch(()=>{})
                return true
            }
        }
        return false
    }

    private async ensureTotpInput(page: Page): Promise<string | null> {
        const selector = await this.findFirstVisibleSelector(page, this.totpInputSelectors())
        if (selector) return selector

        const attempts = 4
        for (let i = 0; i < attempts; i++) {
            let acted = false

            // Step 1: expose alternative verification options if hidden
            if (!acted) {
                acted = await this.clickFirstVisibleSelector(page, this.totpAltOptionSelectors())
                if (acted) await this.bot.utils.wait(900)
            }

            // Step 2: choose authenticator code option if available
            if (!acted) {
                acted = await this.clickFirstVisibleSelector(page, this.totpChallengeSelectors())
                if (acted) await this.bot.utils.wait(900)
            }

            const ready = await this.findFirstVisibleSelector(page, this.totpInputSelectors())
            if (ready) return ready

            if (!acted) break
        }

        return null
    }

    private async submitTotpCode(page: Page, selector: string) {
        try {
            const code = generateTOTP(this.currentTotpSecret!.trim())
            const input = page.locator(selector).first()
            if (!await input.isVisible().catch(()=>false)) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'TOTP input unexpectedly hidden', 'warn')
                return
            }
            await input.fill('')
            await input.fill(code)
            // Use unified selector system
            const submit = await this.findFirstVisibleLocator(page, Login.TOTP_SELECTORS.submit)
            if (submit) {
                await submit.click().catch(()=>{})
            } else {
                await page.keyboard.press('Enter').catch(()=>{})
            }
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Submitted TOTP automatically')
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Failed to submit TOTP automatically: ' + error, 'warn')
        }
    }

    private async findFirstVisibleLocator(page: Page, selectors: readonly string[]): Promise<any | null> {
        for (const sel of selectors) {
            const loc = page.locator(sel).first()
            if (await loc.isVisible().catch(() => false)) return loc
        }
        return null
    }

    // --------------- Your Original Methods (Enhanced) ---------------
    async login(page: Page, email: string, password: string, totpSecret?: string) {
        try {
            // Clear any existing intervals from previous runs
            if (this.compromisedInterval) {
                clearInterval(this.compromisedInterval)
                this.compromisedInterval = undefined
            }

            this.bot.log(this.bot.isMobile, 'LOGIN', 'Starting login process!')

            // Store TOTP secret if provided
            this.currentTotpSecret = (totpSecret && totpSecret.trim()) || undefined;

            // Navigate to the Bing login page
            await page.goto('https://rewards.bing.com/signin', {
                timeout: 120000, // 2 minutes (in milliseconds)
            })

            // Disable FIDO support in login request
            await this.disableFido(page)

            await page.waitForLoadState('domcontentloaded').catch(() => { })
            await this.bot.browser.utils.reloadBadPage(page)

            // Check if account is locked
            await this.checkAccountLocked(page)

            const isLoggedIn = await page.waitForSelector('html[data-role-name="RewardsPortal"]', { timeout: 120000 }).then(() => true).catch(() => false)

            if (!isLoggedIn) {
                const execResult = await this.execLogin(page, email, password)
                if (!execResult) {
                    // Emit login failure error
                    this.emitError({
                        type: 'LOGIN_FAILED',
                        email: email,
                        message: `Login failed for ${email} after retries`,
                        retryAfterMs: 10 * 60 * 1000, // 10 minutes
                        shouldRestartBrowsers: true
                    });

                    this.bot.log(this.bot.isMobile, 'LOGIN', `Login failed for ${email} after retries — skipping to next account.`, 'warn')
                    return
                }
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Logged into Microsoft successfully')
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Already logged in')
                await this.checkAccountLocked(page)
            }

            // Verify Bing login and save session
            await this.verifyBingContext(page)

            // Sometimes onboarding/welcome modals appear right after login; dismiss them if present
            await this.dismissWelcomeModal(page)

            await saveSessionData(this.bot.config.sessionPath, page.context(), email, this.bot.isMobile)
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Logged in successfully, saved login session!')

            // Clear TOTP secret after successful login
            this.currentTotpSecret = undefined;

        } catch (error) {
            // Clear TOTP secret on error
            this.currentTotpSecret = undefined;

            // Emit error for any login failure
            this.emitError({
                type: 'LOGIN_FAILED',
                email: email,
                message: `Login error for ${email}: ${error}`,
                retryAfterMs: 10 * 60 * 1000, // 10 minutes
                shouldRestartBrowsers: true
            });

            throw this.bot.log(this.bot.isMobile, 'LOGIN', 'An error occurred:' + error, 'error')
        }
    }

    /**
     * Exec login: attempt the full login flow, up to maxAttempts.
     * On retry we open a NEW TAB, go to https://rewards.bing.com, close the previous tab,
     * and re-run the login steps using the fresh tab (this forces a new send/resend).
     *
     * Returns true if login succeeded; false if exhausted retries and the account was marked for later.
     */
    private async execLogin(page: Page, email: string, password: string): Promise<boolean> {
        const maxAttempts = 3

        // We'll operate on currentPage, which may be replaced with a fresh tab on retries.
        let currentPage: Page = page

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                this.bot.log(this.bot.isMobile, 'LOGIN', `execLogin attempt ${attempt}/${maxAttempts}`)

                // On every attempt, navigate to the sign-in page to ensure a fresh start
                try {
                    await currentPage.goto('https://rewards.bing.com/signin', { waitUntil: 'domcontentloaded', timeout: 120000 })
                    await this.bot.utils.wait(1000)
                    await this.bot.browser.utils.reloadBadPage(currentPage)
                } catch (err) {
                    // if currentPage navigation fails, try creating a new page immediately
                    this.bot.log(this.bot.isMobile, 'LOGIN', `Could not navigate current page to signin: ${err}`, 'warn')
                }

                // Enter email and password/2FA with security checks
                await this.enterEmail(currentPage, email)
                await this.bot.utils.wait(1200)
                await this.bot.browser.utils.reloadBadPage(currentPage)
                await this.bot.utils.wait(1200)

                // Security check after email entry
                await this.tryRecoveryMismatchCheck(currentPage, email)
                if (this.bot.compromisedModeActive && this.bot.compromisedReason === 'recovery-mismatch') {
                    this.bot.log(this.bot.isMobile,'LOGIN','Recovery mismatch detected – stopping before password entry','warn')
                    return false
                }

                // Try switching to password if a locale link is present (FR/EN)
                await this.switchToPasswordLink(currentPage)

                const passResult = await this.enterPassword(currentPage, password)
                if (passResult) {
                    // Flow indicates success (send-code UI not present after OTP). Continue normal checks.
                    await this.bot.utils.wait(1200)
                    await this.bot.browser.utils.reloadBadPage(currentPage)
                    await this.checkLoggedIn(currentPage)

                    // Dismiss any post-login welcome/onboarding modals that sometimes appear
                    await this.dismissWelcomeModal(currentPage)

                    // Close any other tabs except the current one? We won't force-close here.
                    return true
                } else {
                    // We need to retry the full login from scratch (missing/invalid OTP or couldn't fetch)
                    if (attempt < maxAttempts) {
                        // backoff between 10-15 minutes before trying again
                        const backoff = Math.floor(Math.random() * (MAX_RETRY_BACKOFF_MS - MIN_RETRY_BACKOFF_MS + 1)) + MIN_RETRY_BACKOFF_MS
                        this.bot.log(this.bot.isMobile, 'LOGIN', `Login attempt detected failed OTP/send-code present. Waiting ${Math.round(backoff/60000)} minutes before retrying...`, 'warn')
                        await this.bot.utils.wait(backoff)

                        // Open a new tab in same context and navigate to rewards to reset/resend the code
                        try {
                            const context = currentPage.context()
                            const newPage: Page = await (context as any).newPage()
                            await newPage.goto('https://rewards.bing.com', { waitUntil: 'domcontentloaded',timeout: 120000 })
                            await this.bot.utils.wait(1500)

                            // WAIT: ensure previous page/context settles before closing the old page.
                            // Some environments require ~40-60 seconds to allow background cleanup; add randomized delay.
                            const waitMs = 40000 + Math.floor(Math.random() * 20000); // 40-60 seconds
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Waiting ${waitMs}ms after opening new page before closing old page to avoid race conditions`);
                            await this.bot.utils.wait(waitMs);

                            // Close previous page if it still exists and is different
                            try {
                                if (currentPage && currentPage !== newPage) {
                                    await currentPage.close().catch(() => { })
                                }
                            } catch { /* ignore close errors */ }

                            // Use the new page for the next attempt
                            currentPage = newPage
                            this.bot.log(this.bot.isMobile, 'LOGIN', 'Opened fresh tab for retry and navigated to rewards.bing.com')
                        } catch (err) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Failed to open fresh tab before retrying: ${err}`, 'warn')
                            // small wait before next attempt; attempt loop will retry using the same currentPage
                            await this.bot.utils.wait(2000)
                        }

                        // Continue to next attempt
                        continue
                    } else {
                        // exhausted attempts: handle failed login (do not throw) and return false to caller
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Exceeded maximum login retries due to missing/invalid OTP from Gmail. Marking account to try later and cleaning up.', 'error')
                        try {
                            await this.handleFailedLogin(currentPage, email)
                        } catch (err) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Error while handling failed login cleanup: ${err}`, 'error')
                        }
                        return false
                    }
                }
            } catch (error) {
                if (attempt >= maxAttempts) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', `execLogin failed on final attempt: ${error}`, 'error')
                    try {
                        await this.handleFailedLogin(currentPage, email)
                    } catch (err) {
                        this.bot.log(this.bot.isMobile, 'LOGIN', `Error while handling failed login cleanup after exception: ${err}`, 'error')
                    }
                    return false
                } else {
                    this.bot.log(this.bot.isMobile, 'LOGIN', `execLogin caught error on attempt ${attempt}: ${error}`, 'warn')
                    // small wait then next attempt
                    await this.bot.utils.wait(2000)
                }
            }
        }

        // Shouldn't normally reach here, but indicate failure defensively
        try {
            await this.handleFailedLogin(page, email)
        } catch { }
        return false
    }

    private async enterEmail(page: Page, email: string) {
        const emailInputSelector = 'input[type="email"]'

        try {
            const emailField = await page.waitForSelector(emailInputSelector, { state: 'visible', timeout: 120000 }).catch(() => null)
            if (!emailField) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Email field not found', 'warn')
                return
            }

            await this.bot.utils.wait(800)

            const emailPrefilled = await page.waitForSelector('#userDisplayName', { timeout: 120000 }).catch(() => null)
            if (emailPrefilled) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Email already prefilled by Microsoft')
            } else {
                await page.fill(emailInputSelector, '')
                await this.bot.utils.wait(400)
                await page.fill(emailInputSelector, email)
                await this.bot.utils.wait(800)
            }

            const nextButton = await page.waitForSelector('button[type="submit"]', { timeout: 120000 }).catch(() => null)
            if (nextButton) {
                await nextButton.click()
                await this.bot.utils.wait(2000)
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Email entered successfully')
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Next button not found after email entry', 'warn')
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Email entry failed: ${error}`, 'error')
        }
    }

    /**
     * Returns true if flow progressed/was handled (login should continue). Returns false if
     * the send-code UI remains after OTP submission (indicating failure), which will trigger a retry.
     */
    private async enterPassword(page: Page, password: string): Promise<boolean> {
        const passwordInputSelector = 'input[type="password"]'
        const skip2FASelector = '#idA_PWD_SwitchToPassword';

        const codeFlowSelectors = [
            'text=Get a code to sign in',
            'button:has-text("Send code")',
            'button:has-text("Send")',
            'button[aria-label="Send code"]',
            '#idDiv_SAOTCS_Proofs',
            'text=/Enter your code/i',
            'text=/Enter the code we sent/i',
            'text=Verify your identity',
            'text=I have a code',
            'text=Show more verification methods'
        ]

        try {
            // Security check before password entry
            const blocked = await this.detectSignInBlocked(page)
            if (blocked) return false

            const skip2FAButton = await page.waitForSelector(skip2FASelector, { timeout: 120000 }).catch(() => null)
            if (skip2FAButton) {
                await skip2FAButton.click()
                await this.bot.utils.wait(1200)
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Skipped 2FA')
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'No 2FA skip button found, proceeding with password entry')
            }

            await this.bot.utils.wait(800)

            // FIRST attempt: look directly for password input and fill if present
            const passwordField = await page.waitForSelector(passwordInputSelector, { state: 'visible', timeout: 120000 }).catch(() => null)
            if (passwordField) {
                await this.bot.utils.wait(700)
                await page.fill(passwordInputSelector, '')
                await this.bot.utils.wait(300)
                await page.fill(passwordInputSelector, password)
                await this.bot.utils.wait(400)

                const nextButton = await page.waitForSelector('button[type="submit"]', { timeout: 4000 }).catch(() => null)
                if (nextButton) {
                    await nextButton.click()
                    await this.bot.utils.wait(1800)
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Password entered successfully')

                    // Handle potential post-password verification (e.g., email code after password)
                    await this.bot.utils.wait(3000)
                    const codeDetectedAfterPw = await this.detectCodeFlow(page, codeFlowSelectors)
                    if (codeDetectedAfterPw) {
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Detected email code verification after password submission')
                        return await this.handleEmailCodeVerification(page, password)
                    }
                } else {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Next button not found after password entry', 'warn')
                }
                return true
            }

            this.bot.log(this.bot.isMobile, 'LOGIN', 'Password field not found - checking for explicit "Use your password" / password option')

            // NEW: look for "use your password" / password-option UI and prefer that over send-code flow
            const passwordOptionSelectors = [
                'button:has-text("Use your password")',
                'a:has-text("Use your password")',
                'text=/use your password/i',
                'button:has-text("Sign in with password")',
                'text=/sign in with password/i',
                'button:has-text("Use a password")',
                'text=/use a password/i',
                'text=/use password/i',
                'text=/password/i' // last-resort catch (will be filtered further below)
            ]

            // Try to find and click a password-option element (prefer exact phrases first)
            let passwordOptionClicked = false
            for (const sel of passwordOptionSelectors) {
                try {
                    const el = page.locator(sel).first()
                    if (await el.isVisible().catch(() => false)) {
                        this.bot.log(this.bot.isMobile, 'LOGIN', `Found potential password-option UI via selector: ${sel}`)
                        // click it and then try to find the password field again
                        try {
                            await el.click().catch(() => { })
                            await this.bot.utils.wait(900)
                            passwordOptionClicked = true
                        } catch (clickErr) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Failed to click password-option (${sel}): ${clickErr}`, 'warn')
                        }
                        // if we clicked one, break out and attempt to fill password
                        if (passwordOptionClicked) break
                    }
                } catch { /* ignore per-selector errors */ }
            }

            // If we didn't explicitly click a named password-option, do one more scan of generic buttons/links for password wording
            if (!passwordOptionClicked) {
                try {
                    const candidates = await page.$$('button, a')
                    for (const c of candidates) {
                        try {
                            const txt = (await c.innerText().catch(() => '')).trim().toLowerCase()
                            if (!txt) continue
                            // require a stronger match than generic 'password' — look for phrases
                            if (txt.includes('use your password') || txt.includes('sign in with password') || txt.includes('use a password') || txt.includes('use password') || txt.includes('sign in with your password')) {
                                if (await c.isVisible().catch(() => false)) {
                                    await c.click().catch(() => { })
                                    await this.bot.utils.wait(900)
                                    passwordOptionClicked = true
                                    this.bot.log(this.bot.isMobile, 'LOGIN', `Clicked password-option by scanning buttons/links: "${txt}"`)
                                    break
                                }
                            }
                        } catch { /* ignore per-button errors */ }
                    }
                } catch { /* ignore */ }
            }

            // If we clicked a password option, try to locate the password input now and fill it
            if (passwordOptionClicked) {
                // give the UI a short moment to render the password input
                await this.bot.utils.wait(600)
                const pwdFieldAfterClick = await page.waitForSelector(passwordInputSelector, { state: 'visible', timeout: 120000 }).catch(() => null)
                if (pwdFieldAfterClick) {
                    await this.bot.utils.wait(400)
                    await page.fill(passwordInputSelector, '')
                    await this.bot.utils.wait(300)
                    await page.fill(passwordInputSelector, password)
                    await this.bot.utils.wait(400)

                    const nextButton2 = await page.waitForSelector('button[type="submit"]', { timeout: 120000 }).catch(() => null)
                    if (nextButton2) {
                        await nextButton2.click()
                        await this.bot.utils.wait(1800)
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Password entered successfully (after clicking password-option).')

                        // Handle potential post-password verification (e.g., email code after password)
                        await this.bot.utils.wait(3000)
                        const codeDetectedAfterPw = await this.detectCodeFlow(page, codeFlowSelectors)
                        if (codeDetectedAfterPw) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', 'Detected email code verification after password submission (post-option)')
                            return await this.handleEmailCodeVerification(page, password)
                        }
                    } else {
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Next button not found after password entry (post password-option click).', 'warn')
                    }
                    return true
                } else {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Clicked password-option but password input did not appear; will continue to code-send detection', 'warn')
                }
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'No explicit password-option UI detected; falling back to code-send detection')
            }

            // --- existing logic: check code/send-code flow if password path not available ---
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Password field not found - checking for "Get a code to sign in" flow')

            const codeFlowDetected = await this.detectCodeFlow(page, codeFlowSelectors)
            if (codeFlowDetected) {
                return await this.handleEmailCodeVerification(page, password)
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'No code flow detected; falling back to enhanced 2FA handlers')
            }

            // Enhanced 2FA handling with improved TOTP support
            try {
                await this.handle2FA(page)

                // post-manual checks for errors or remaining code UI
                const otpErrorSelectorsAfterManual = [
                    'text=/that code is incorrect/i',
                    'text=/enter your code/i',
                    'text=/the code you entered/i',
                    'text=/check the code and try again/i',
                    'text=/code.*incorrect/i'
                ]
                for (const sel of otpErrorSelectorsAfterManual) {
                    try {
                        if (await page.locator(sel).first().isVisible().catch(() => false)) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Detected explicit OTP error after manual 2FA: ${sel}`, 'warn')
                            return false
                        }
                    } catch { /* ignore */ }
                }

                const otpInputsStill = await page.locator('input[name="otc"], input[maxlength="1"], input[type="tel"], input[aria-label*="digit"]').first().isVisible().catch(() => false)
                if (otpInputsStill) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'OTP inputs are still present after manual 2FA — treating as failure.', 'warn')
                    return false
                }

                for (const sel of codeFlowSelectors) {
                    try {
                        if (await page.locator(sel).first().isVisible().catch(() => false)) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `After manual 2FA, still on code flow (selector present): ${sel}`, 'warn')
                            return false
                        }
                    } catch { /* ignore */ }
                }

                this.bot.log(this.bot.isMobile, 'LOGIN', 'Manual 2FA completed and no send-code UI or errors present — treating as successful login.')
                return true
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `handle2FA threw an error: ${err}`, 'warn')
                return false
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Password entry failed: ${error}`, 'error')
            return false
        }
    }

    // --------------- Enhanced 2FA Handling with Improved TOTP ---------------
    private async handle2FA(page: Page) {
        try {
            // First try enhanced TOTP if secret is available
            if (this.currentTotpSecret) {
                try {
                    const totpSelector = await this.ensureTotpInput(page)
                    if (totpSelector) {
                        await this.submitTotpCode(page, totpSelector)
                        return
                    }
                } catch (error) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', `Enhanced TOTP auto-fill failed: ${error}`, 'warn')
                    // Fall through to other methods
                }
            }

            const numberToPress = await this.get2FACode(page)
            if (numberToPress) {
                await this.authAppVerification(page, numberToPress)
            } else {
                await this.authSMSVerification(page)
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `2FA handling failed: ${error}`)
        }
    }

    private async get2FACode(page: Page): Promise<string | null> {
        const selectors = [
            '#displaySign',
            'div[data-testid="displaySign"]>span',
            'text=Approve sign-in',
            'text=Approve'
        ]

        for (const sel of selectors) {
            try {
                const el = await page.waitForSelector(sel, { state: 'visible', timeout: 120000 }).catch(() => null)
                if (el) {
                    const txt = (await el.textContent().catch(() => null)) ?? null
                    if (txt) return txt
                }
            } catch { /* ignore */ }
        }

        if (this.bot.config.parallel) {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Script running in parallel; waiting for push approval flow...', 'log', 'yellow')
            const retryButtonSelectors = [
                'button[aria-describedby="pushNotificationsTitle errorDescription"]',
                'button[data-testid="primaryButton"]',
                'button:has-text("Try again")',
                'button:has-text("Resend")'
            ]
            for (let attempt = 0; attempt < 6; attempt++) {
                for (const rsel of retryButtonSelectors) {
                    try {
                        const b = await page.waitForSelector(rsel, { timeout: 120000 }).catch(() => null)
                        if (b) { await b.click().catch(() => { }) ; this.bot.log(this.bot.isMobile, 'LOGIN', `Clicked retry button: ${rsel}`) }
                    } catch { /* ignore */ }
                }
                await this.bot.utils.wait(60000)
                for (const sel of selectors) {
                    try {
                        const el = await page.waitForSelector(sel, { state: 'visible', timeout: 120000 }).catch(() => null)
                        if (el) {
                            const t = (await el.textContent().catch(() => null)) ?? null
                            if (t) return t
                        }
                    } catch { /* ignore */ }
                }
            }
        }

        try {
            const confirm = await page.waitForSelector('button[aria-describedby="confirmSendTitle"], button:has-text("Send")', { timeout: 120000 }).catch(() => null)
            if (confirm) {
                await confirm.click().catch(() => { })
                await this.bot.utils.wait(2000)
                const el = await page.waitForSelector('#displaySign, div[data-testid="displaySign"]>span', { timeout: 120000 }).catch(() => null)
                if (el) {
                    const t = (await el.textContent().catch(() => null)) ?? null
                    if (t) return t
                }
            }
        } catch { /* ignore */ }

        return null
    }

    private async authAppVerification(page: Page, numberToPress: string | null) {
        while (true) {
            try {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Press the number ${numberToPress} on your Authenticator app to approve the login`)
                this.bot.log(this.bot.isMobile, 'LOGIN', 'If you press the wrong number or the "DENY" button, try again in 60 seconds')
                await page.waitForSelector('form[name="f1"]', { state: 'detached', timeout: 120000 })
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Login successfully approved!')
                break
            } catch {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'The code is expired. Trying to get a new code...')
                const primaryButton = await page.waitForSelector('button[data-testid="primaryButton"]', { state: 'visible', timeout: 120000 }).catch(() => null)
                if (primaryButton) { await primaryButton.click().catch(() => { }) }
                numberToPress = await this.get2FACode(page)
            }
        }
    }

    private async authSMSVerification(page: Page) {
        // Enhanced TOTP handling (second chance)
        if (this.currentTotpSecret) {
            try {
                const totpSelector = await this.ensureTotpInput(page)
                if (totpSelector) {
                    await this.submitTotpCode(page, totpSelector)
                    return
                }
            } catch (error) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Enhanced TOTP fallback failed: ${error}`, 'warn')
            }
        }

        // Manual prompt fallback with enhanced monitoring
        this.bot.log(this.bot.isMobile, 'LOGIN', 'SMS 2FA code required. Waiting for user input...')

        // Monitor page changes while waiting for user input
        let checkInterval: NodeJS.Timeout | null = null
        let userInput: string | null = null

        try {
            const inputPromise = new Promise<string>((resolve) => {
                rl.question('Enter 2FA code:\n', (input) => {
                    if (checkInterval) clearInterval(checkInterval)
                    rl.close()
                    resolve(input)
                })
            })

            // Check every 2 seconds if user manually progressed past the dialog
            checkInterval = setInterval(async () => {
                try {
                    await this.bot.browser.utils.tryDismissAllMessages(page)
                    // Check if we're no longer on 2FA page
                    const still2FA = await page.locator('input[name="otc"]').first().isVisible({ timeout: 500 }).catch(() => false)
                    if (!still2FA) {
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Page changed during 2FA wait (user may have clicked Next)', 'warn')
                        if (checkInterval) clearInterval(checkInterval)
                        rl.close()
                        userInput = 'skip' // Signal to skip submission
                    }
                } catch {/* ignore */}
            }, 2000)

            const code = await inputPromise

            if (code === 'skip' || userInput === 'skip') {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Skipping 2FA code submission (page progressed)')
                return
            }

            await page.fill('input[name="otc"]', code)
            await page.keyboard.press('Enter')
            this.bot.log(this.bot.isMobile, 'LOGIN', '2FA code submitted')
        } finally {
            // Ensure cleanup happens even if errors occur
            if (checkInterval) clearInterval(checkInterval)
            try { rl.close() } catch {/* ignore */}
        }
    }

    // --------------- Your Original Methods (Keep All Functionality) ---------------

    // Handle common optional login prompts (Stay signed in?, Skip, Not now, etc.).
    private async randomLongWait(page: Page, minMs: number = 60000, maxMs: number = 90000) {
        const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        await page.waitForTimeout(500);
        await this.handleOptionalPrompts(page);
        await page.waitForTimeout(ms);
    }

    private async handleOptionalPrompts(page: Page) {
        const tries = [
            `button#idBtn_Back`, // often the "No" button
            `button#idSIButton9`,
            `button:has-text("No")`,
            `button:has-text("Don't show again")`,
            `button:has-text("Skip")`,
            `button:has-text("Not now")`,
            `button:has-text("Use another account")`,
            `button:has-text("Continue")`,
            `input[type="button"][value="No"]`,
            // Added for terms update and similar sequential prompts
            `button:has-text("Next")`,
            `button:has-text("Yes")`,
            `button:has-text("Accept")`,
            `button:has-text("Agree")`,
            `button:has-text("I accept")`,
            `button[type="submit"]`,
            `input[type="submit"]`,
            `button:has-text("Get started")`,
            `button:has-text("Let's go")`,
            `button:has-text("OK")`,
        ];

        let dismissedAny = false;
        const maxPromptLoops = 10;
        let loopCount = 0;

        while (loopCount < maxPromptLoops) {
            let dismissedThisLoop = false;
            for (const sel of tries) {
                try {
                    const handle = await page.$(sel);
                    if (handle) {
                        try {
                            await handle.click();
                            dismissedThisLoop = true;
                            dismissedAny = true;
                        } catch (e) {
                            try {
                                await page.evaluate((s) => {
                                    const el = document.querySelector(s) as HTMLElement | null;
                                    if (el) el.click();
                                }, sel);
                                dismissedThisLoop = true;
                                dismissedAny = true;
                            } catch (ee) {
                                // ignore
                            }
                        }
                        await page.waitForTimeout(800);
                        break;
                    }
                } catch (e) {
                    // ignore and continue
                }
            }

            if (!dismissedThisLoop) {
                break;
            }

            loopCount++;
        }

        if (dismissedAny) {
            await this.randomLongWait(page);
        }

        // Enhanced passkey handling from main branch
        await this.handlePasskeyPrompts(page, 'main')

        // As a fallback, press Escape if a dialog overlay is detected
        try {
            const dialog = await page.$('[role="dialog"], .modal, .ms-Dialog, .overlay, .authModal');
            if (dialog) {
                const isVisible = await (dialog as any).isVisible?.();
                if (isVisible !== false) {
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(600);
                }
            }
        } catch (e) {
            // ignore
        }
    }

    // Enhanced passkey handling from main branch
    private async handlePasskeyPrompts(page: Page, context: 'main' | 'oauth') {
        let did = false
        // Video heuristic
        const biometric = await page.waitForSelector(SELECTORS.biometricVideo, { timeout: 500 }).catch(()=>null)
        if (biometric) {
            const btn = await page.$(SELECTORS.passkeySecondary)
            if (btn) { await btn.click().catch(()=>{}); did = true; this.logPasskeyOnce('video heuristic') }
        }
        if (!did) {
            const titleEl = await page.waitForSelector(SELECTORS.passkeyTitle, { timeout: 500 }).catch(()=>null)
            const secBtn = await page.waitForSelector(SELECTORS.passkeySecondary, { timeout: 500 }).catch(()=>null)
            const primBtn = await page.waitForSelector(SELECTORS.passkeyPrimary, { timeout: 500 }).catch(()=>null)
            const title = (titleEl ? (await titleEl.textContent()) : '')?.trim() || ''
            const looksLike = /sign in faster|passkey|fingerprint|face|pin/i.test(title)
            if (looksLike && secBtn) { await secBtn.click().catch(()=>{}); did = true; this.logPasskeyOnce('title heuristic '+title) }
            else if (!did && secBtn && primBtn) {
                const text = (await secBtn.textContent()||'').trim()
                if (/skip for now/i.test(text)) { await secBtn.click().catch(()=>{}); did = true; this.logPasskeyOnce('secondary button text') }
            }
            if (!did) {
                const textBtn = await page.locator('xpath=//button[contains(normalize-space(.),"Skip for now")]').first()
                if (await textBtn.isVisible().catch(()=>false)) { await textBtn.click().catch(()=>{}); did = true; this.logPasskeyOnce('text fallback') }
            }
            if (!did) {
                const close = await page.$('#close-button')
                if (close) { await close.click().catch(()=>{}); did = true; this.logPasskeyOnce('close button') }
            }
        }

        // KMSI prompt
        const kmsi = await page.waitForSelector(SELECTORS.kmsiVideo, { timeout: 400 }).catch(()=>null)
        if (kmsi) {
            const yes = await page.$(SELECTORS.passkeyPrimary)
            if (yes) { await yes.click().catch(()=>{}); did = true; this.bot.log(this.bot.isMobile,'LOGIN-KMSI','Accepted KMSI prompt') }
        }

        if (!did && context === 'main') {
            this.noPromptIterations++
            const now = Date.now()
            if (this.noPromptIterations === 1 || now - this.lastNoPromptLog > 10000) {
                this.lastNoPromptLog = now
                this.bot.log(this.bot.isMobile,'LOGIN-NO-PROMPT',`No dialogs (x${this.noPromptIterations})`)
                if (this.noPromptIterations > 50) this.noPromptIterations = 0
            }
        } else if (did) {
            this.noPromptIterations = 0
        }
    }

    private logPasskeyOnce(reason: string) {
        if (this.passkeyHandled) return
        this.passkeyHandled = true
        this.bot.log(this.bot.isMobile,'LOGIN-PASSKEY',`Dismissed passkey prompt (${reason})`)
    }

    // All your original email code verification methods remain the same
    private async detectCodeFlow(page: Page, codeFlowSelectors: string[]): Promise<boolean> {
        let codeFlowDetected = false
        for (const sel of codeFlowSelectors) {
            try {
                const loc = page.locator(sel).first()
                if (await loc.isVisible().catch(() => false)) {
                    codeFlowDetected = true
                    this.bot.log(this.bot.isMobile, 'LOGIN', `Detected code flow using selector: ${sel}`)
                    break
                }
            } catch { /* ignore */ }
        }

        if (!codeFlowDetected) {
            try {
                const bigButtons = await page.$$('button')
                for (const btn of bigButtons) {
                    try {
                        const txt = (await btn.innerText().catch(() => '')).trim().toLowerCase()
                        if (txt.includes('send code') || txt === 'send' || txt.includes('continue')) {
                            const visible = await btn.isVisible().catch(() => false)
                            if (visible) {
                                codeFlowDetected = true
                                this.bot.log(this.bot.isMobile, 'LOGIN', `Detected code flow by scanning button text: "${txt}"`)
                                break
                            }
                        }
                    } catch { /* ignore */ }
                }
            } catch { /* ignore */ }
        }
        return codeFlowDetected
    }

    private async handleEmailCodeVerification(page: Page, password: string): Promise<boolean> {
        const verificationSelectors = [
            'text=I have a code',
            'text=Show more verification methods',
            'a#signInAnotherWay', // from research
            'div[data-value="PhoneAppOTP"]' // for TOTP option if available
        ]

        for (const sel of verificationSelectors) {
            try {
                const el = await page.locator(sel).first()
                if (await el.isVisible().catch(() => false)) {
                    await el.click().catch(() => {})
                    this.bot.log(this.bot.isMobile, 'LOGIN', `Clicked verification option: ${sel}`)
                    await this.bot.utils.wait(1000)
                }
            } catch { /* ignore */ }
        }

        // Now check if OTP input is already visible (code may have been auto-sent)
        const otpInputSelectors = [
            'input[name="otc"]',
            'input#idTxtBx_SAOTCC_OTC', // from research
            'input[maxlength="1"]', // for multi-digit
            'input[type="tel"]',
            'input[aria-label*="digit"]'
        ]

        let otpInputVisible = false
        for (const sel of otpInputSelectors) {
            try {
                if (await page.locator(sel).first().isVisible().catch(() => false)) {
                    otpInputVisible = true
                    break
                }
            } catch { /* ignore */ }
        }

        let sendClicked = false
        if (!otpInputVisible) {
            // Try to send the code if input not visible
            const sendSelectors = [
                'button:has-text("Send code")',
                'button[aria-label="Send code"]',
                'button[data-testid="primaryButton"]',
                'button:has-text("Send")',
                'button:has-text("Continue")',
                'button:has-text("Next")'
            ]

            for (const sel of sendSelectors) {
                try {
                    const btn = await page.waitForSelector(sel, { timeout: 120000 }).catch(() => null)
                    if (btn) {
                        await btn.click().catch(() => { })
                        sendClicked = true
                        this.bot.log(this.bot.isMobile, 'LOGIN', `Clicked send/confirm button using selector: ${sel}`)
                        break
                    }
                } catch { /* ignore */ }
            }

            if (!sendClicked) {
                try {
                    const fallbackBtn = await page.$('button')
                    if (fallbackBtn && await fallbackBtn.isVisible().catch(() => false)) {
                        const text = (await fallbackBtn.innerText().catch(() => '')).trim().toLowerCase()
                        if (text.includes('send') || text.includes('continue')) {
                            await fallbackBtn.click().catch(() => { })
                            sendClicked = true
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Clicked fallback send button with text: "${text}"`)
                        }
                    }
                } catch { /* ignore */ }
            }
        } else {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'OTP input already visible — assuming code was auto-sent, proceeding to fetch.')
        }

        const waitMs = (this.bot.config as any)?.emailWaitMs ?? DEFAULT_EMAIL_WAIT_MS
        if (sendClicked || otpInputVisible) {
            await this.bot.utils.wait(waitMs)
        } else {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Did not click send or detect OTP input but will attempt to fetch code anyway', 'warn')
            await this.bot.utils.wait(waitMs)
        }

        // Wait 3-4 minutes before checking Gmail to allow email delivery
        const preFetchWait = Math.floor(Math.random() * (MAX_EMAIL_WAIT_BEFORE_FETCH_MS - MIN_EMAIL_WAIT_BEFORE_FETCH_MS + 1)) + MIN_EMAIL_WAIT_BEFORE_FETCH_MS
        this.bot.log(this.bot.isMobile, 'LOGIN', `Waiting ${Math.round(preFetchWait/60000 * 100)/100} minutes before checking Gmail for the code...`)
        await this.bot.utils.wait(preFetchWait)

        try {
            const code = await this.fetchCodeFromGmail(page, password)
            if (code) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Retrieved code from Gmail: ${code}`)

                const otpFilled = await this.fillOtpInputs(page, code)
                if (!otpFilled) {
                    try {
                        await page.fill('input[name="otc"], input[type="text"], input[type="tel"]', code).catch(() => { })
                    } catch { /* ignore */ }
                }

                await page.keyboard.press('Enter').catch(() => { })
                await this.bot.utils.wait(3000)

                // --- explicit checks for OTP rejection / still asking for code ---
                const otpErrorSelectors = [
                    'text=/that code is incorrect/i',
                    'text=/enter your code/i',
                    'text=/the code you entered/i',
                    'text=/check the code and try again/i',
                    'text=/code.*incorrect/i'
                ]

                for (const sel of otpErrorSelectors) {
                    try {
                        if (await page.locator(sel).first().isVisible().catch(() => false)) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Detected explicit OTP error after submission: ${sel}`, 'warn')
                            return false
                        }
                    } catch { /* ignore */ }
                }

                const otpInputsPresent = await page.locator('input[name="otc"], input[maxlength="1"], input[type="tel"], input[aria-label*="digit"]').first().isVisible().catch(() => false)
                if (otpInputsPresent) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'OTP inputs still present after submission — treating as failure (code rejected or still waiting).', 'warn')
                    return false
                }

                const codeFlowSelectors = [
                    'text=Get a code to sign in',
                    'button:has-text("Send code")',
                    'button:has-text("Send")',
                    'button[aria-label="Send code"]',
                    '#idDiv_SAOTCS_Proofs',
                    'text=/Enter your code/i',
                    'text=/Enter the code we sent/i'
                ]
                for (const sel of codeFlowSelectors) {
                    try {
                        if (await page.locator(sel).first().isVisible().catch(() => false)) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `After OTP submission, still on code flow (selector present): ${sel}`, 'warn')
                            return false
                        }
                    } catch { /* ignore */ }
                }

                // If none of the failure signals are present, treat as success
                this.bot.log(this.bot.isMobile, 'LOGIN', 'No send-code UI or OTP error detected after submission — treating as successful login.')
                return true

            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Could not retrieve code from Gmail', 'warn')
                return false
            }
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Error fetching code from Gmail: ${err}`, 'error')
            return false
        }
    }

    /**
     * Try to fill multi-input OTP UIs (common pattern is several <input maxlength="1">).
     * Returns true if it handled filling; false otherwise.
     */
    private async fillOtpInputs(page: Page, code: string): Promise<boolean> {
        try {
            const containers = [
                '[data-testid="otpInputs"]',
                '#otcContainer',
                'div[role="main"]',
                'form'
            ]

            for (const contSel of containers) {
                try {
                    const container = page.locator(contSel).first()
                    if (!container) continue
                    const inputs = container.locator('input[maxlength="1"], input[aria-label*="digit"], input[aria-label*="code"]')
                    const count = await inputs.count().catch(() => 0)
                    if (count >= 2) {
                        for (let i = 0; i < Math.min(count, code.length); i++) {
                            const digit: string = code.charAt(i)
                            const input = inputs.nth(i)
                            try {
                                await input.click({ timeout: 120000 }).catch(() => { })
                                await input.fill(digit).catch(async () => {
                                    await input.type(digit, { delay: 80 }).catch(() => { })
                                })
                                await this.bot.utils.wait(100)
                            } catch { /* ignore per-digit failures */ }
                        }
                        return true
                    }
                } catch { /* ignore container errors */ }
            }

            const multiInputs = page.locator('input[maxlength="1"], input[type="tel"][maxlength="1"]')
            const total = await multiInputs.count().catch(() => 0)
            if (total >= 2) {
                for (let i = 0; i < Math.min(total, code.length); i++) {
                    const d: string = code.charAt(i)
                    const inp = multiInputs.nth(i)
                    try {
                        await inp.click().catch(() => { })
                        await inp.fill(d).catch(async () => {
                            await inp.type(d, { delay: 80 }).catch(() => { })
                        })
                        await this.bot.utils.wait(100)
                    } catch { /* ignore */ }
                }
                return true
            }

            return false
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `fillOtpInputs failed: ${err}`, 'error')
            return false
        }
    }

    // --------------- Enhanced Verification Methods ---------------
    private async checkLoggedIn(page: Page) {
        const targetHostname = 'rewards.bing.com'
        const targetPathname = '/'

        const maxAttempts = 120; // 120 seconds max (1s per iteration)
        let attempts = 0;

        while (attempts < maxAttempts) {
            await this.dismissLoginMessages(page)
            // Try dismissing occasional post-login onboarding/welcome modals
            await this.dismissWelcomeModal(page)
            // Actively handle optional prompts during the wait loop
            await this.handleOptionalPrompts(page)

            const currentURL = new URL(page.url())
            if (currentURL.hostname === targetHostname && currentURL.pathname === targetPathname) {
                break
            }

            attempts++;
            await this.bot.utils.wait(1000);
        }

        if (attempts >= maxAttempts) {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Timeout waiting for rewards portal after login attempts', 'error');
            throw new Error('Login redirect timeout');
        }

        // Use enhanced portal detection from main branch
        const portalSelector = await this.waitForRewardsRoot(page, 120000)
        if (!portalSelector) {
            throw this.bot.log(this.bot.isMobile, 'LOGIN', 'Rewards portal root element missing after navigation', 'error')
        }

        this.bot.log(this.bot.isMobile, 'LOGIN', `Successfully logged into the rewards portal (${portalSelector})`)
    }

    private async waitForRewardsRoot(page: Page, timeoutMs: number): Promise<string | null> {
        const selectors = [
            'html[data-role-name="RewardsPortal"]',
            'html[data-role-name*="RewardsPortal"]',
            'body[data-role-name*="RewardsPortal"]',
            '[data-role-name*="RewardsPortal"]',
            '[data-bi-name="rewards-dashboard"]',
            'main[data-bi-name="dashboard"]',
            '#more-activities',
            '#dashboard'
        ]

        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            for (const sel of selectors) {
                const loc = page.locator(sel).first()
                if (await loc.isVisible().catch(()=>false)) {
                    return sel
                }
            }
            await this.bot.utils.wait(350)
        }
        return null
    }

    private async verifyBingContext(page: Page) {
        try {
            this.bot.log(this.bot.isMobile, 'LOGIN-BING', 'Verifying Bing auth context')
            await page.goto('https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F')
            for (let i=0;i<5;i++) {
                const u = new URL(page.url())
                if (u.hostname === 'www.bing.com' && u.pathname === '/') {
                    await this.bot.browser.utils.tryDismissAllMessages(page)
                    const ok = await page.waitForSelector('#id_n', { timeout: 3000 }).then(()=>true).catch(()=>false)
                    if (ok || this.bot.isMobile) { this.bot.log(this.bot.isMobile,'LOGIN-BING','Bing verification passed'); break }
                }
                await this.bot.utils.wait(1000)
            }
        } catch (e) {
            this.bot.log(this.bot.isMobile, 'LOGIN-BING', 'Bing verification error: '+e, 'warn')
        }
    }

    // --------------- Your Original Utility Methods ---------------
    private async dismissLoginMessages(page: Page) {
        try {
            // Only proceed if we're on a Microsoft login page
            const currentUrl = page.url();
            if (!currentUrl.includes('login.live.com') && !currentUrl.includes('account.microsoft.com')) {
                return;
            }

            // 1. Handle Passkey prompt with more precise detection
            const passkeyPromptDetected = await page.evaluate(() => {
                // Check for passkey-specific indicators
                const titleEl = document.querySelector('[data-testid="title"]');
                const titleText = titleEl ? titleEl.textContent || '' : '';
                const hasBiometricVideo = document.querySelector('[data-testid="biometricVideo"]') !== null;
                const hasPasskeyIndicators = /sign in faster|passkey|biometric|fingerprint|face id|windows hello/i.test(titleText);

                return hasBiometricVideo || hasPasskeyIndicators;
            });

            if (passkeyPromptDetected) {
                // Only click "Skip for now" if it's clearly a passkey prompt
                const skipButton = await page.$('button[data-testid="secondaryButton"]:has-text("Skip for now")');
                if (skipButton) {
                    await skipButton.click({ delay: 50 });
                    this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', 'Safely dismissed "Use Passkey" prompt with "Skip for now" button');
                    await page.waitForTimeout(1000);
                    return;
                }

                // Alternative: look for "No" or "Not now" buttons specifically for passkey
                const noButton = await page.$('button:has-text("No")');
                if (noButton) {
                    await noButton.click({ delay: 50 });
                    this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', 'Safely dismissed "Use Passkey" prompt with "No" button');
                    await page.waitForTimeout(1000);
                    return;
                }
            }

            // Handle "Verify your identity" prompt
            const verifyIdentityDetected = await page.evaluate(() => {
                const titleText = document.body.textContent || '';
                return /verify your identity/i.test(titleText);
            });

            if (verifyIdentityDetected) {
                this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', 'Detected "Verify your identity" prompt');
                // Try to handle by clicking email option or "I have a code"
                const verifyOptions = [
                    'text=Email',
                    'text=I have a code',
                    'text=Show more verification methods',
                    'a#signInAnotherWay'
                ];
                for (const sel of verifyOptions) {
                    try {
                        const el = await page.locator(sel).first();
                        if (await el.isVisible().catch(() => false)) {
                            await el.click({ delay: 50 });
                            this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', `Clicked verification option: ${sel}`);
                            await page.waitForTimeout(1000);
                            break;
                        }
                    } catch { /* ignore */ }
                }
                // After clicking, the code flow should proceed; let enterPassword handle it
                return;
            }

            // 2. Handle "Keep me signed in" with more precision
            const kmsiPromptDetected = await page.evaluate(() => {
                const titleEl = document.querySelector('[data-testid="title"]');
                const titleText = titleEl ? titleEl.textContent || '' : '';
                return /keep me signed in|stay signed in/i.test(titleText);
            });

            if (kmsiPromptDetected) {
                const yesButton = await page.$('button[data-testid="primaryButton"]:has-text("Yes")');
                if (yesButton) {
                    await yesButton.click({ delay: 50 });
                    this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', 'Safely confirmed "Keep me signed in" prompt');
                    await page.waitForTimeout(1000);
                }
            }

            // 3. Only handle the main login page prompt if needed
            if (currentUrl.includes('login.live.com') && currentUrl.includes('oauth20_authorize')) {
                const nextButton = await page.$('button[type="submit"]:has-text("Next")');
                const signInButton = await page.$('button[type="submit"]:has-text("Sign in")');

                if (nextButton || signInButton) {
                    // This is likely the main login flow, not a dismissible prompt
                    this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', 'Detected main login flow, not dismissing');
                    return;
                }
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', `Error dismissing login messages: ${error}`, 'warn');
        }
    }

    /**
     * Try to detect and close common "welcome/tour/onboarding" modals that appear after login.
     */
    private async dismissWelcomeModal(page: Page) {
        try {
            // Only run dismissal on the rewards page after login confirmation and full load.
            try {
                const url = new URL(page.url());
                if (!url.hostname.includes('rewards.bing.com') && !url.pathname.includes('/rewards')) {
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Not on rewards page; skipping dismissal until later.');
                    return;
                }
            } catch { /* ignore URL parse errors */ }

            // Ensure login is confirmed before attempting dismissal
            try {
                const loggedIn = await Promise.race([
                    this.checkBingLoginStatus(page),
                    new Promise<boolean>(res => setTimeout(() => res(false), 5000)) // 5s fallback
                ]);
                if (!loggedIn) {
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Login not confirmed yet; skipping dismissal until after login.');
                    return;
                }
            } catch (e) {
                const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
                this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Error checking login status, skipping dismissal: ${errMsg}`, 'warn');
                return;
            }

            // Wait for the page to finish loading network activity to avoid racing with redirects/refreshes
            await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => { });

            this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Attempting robust popup dismissal (max 2 attempts).');

            // --- selectors + containers (kept from original, plus a few more cancel/back variants) ---
            const closeSelectors = [
                'button[aria-label="Close"]',
                'button[aria-label="Close dialog"]',
                'button[title="Close"]',
                'button[aria-label="Close (Esc)"]',
                'button[aria-label="Dismiss"]',
                '.ms-Dialog button[aria-label="Close"]',
                '.rewards-onboarding .close',
                '.rewards-onboarding button.close',
                '.modal-header button.close',
                '.modal .close',
                '.modal-close',
                '.onboarding-modal button[aria-label="Close"]',
                '.ui-dialog .ui-dialog-titlebar-close',
                'button[aria-label*="close"]',
                'button[aria-label*="dismiss"]',
                'button[data-purpose="close-modal"]',
                '#popUpModal .close',
                '#popUpModal button',
                '.dashboardPopUpModal .close',
                '.dashboardPopUpModal button',
                '.popup .close',
                '.popup-close',
                '.pop-up .close',
                'mee-rewards-user-status-banner .close',
                'mee-rewards-user-status-banner button',
                'div[role="dialog"] button',
                'div[role="alertdialog"] button',
                '.overlay .close',
                '.modal-backdrop',
                '.overlay',
                'button:has-text("Cancel")',
                'button:has-text("Dismiss")',
                'button:has-text("Close")',
                'button:has-text("Back")'
            ];

            const dialogContainers = [
                'div[role="dialog"]',
                'div[role="alertdialog"]',
                '.modal',
                '.ms-Dialog',
                '.onboarding',
                '.rewards-onboarding',
                '.dashboardPopUpModal',
                '#popUpModal',
                '.popup',
                '.streakPause',
                '.streak-pause',
                '[data-testid="popup"]',
                'mee-rewards-user-status-banner',
                '.onboarding-modal',
                '.security-window'
            ];

            // --- new: keywords that indicate "passkey" / passkey setup dialogs (from screenshots) ---
            const passkeyKeywords = [
                'passkey',
                'pass key',
                'pass-key',
                'setting up your passkey',
                'choose where to save your passkey',
                'passkeys',
                'set up your passkey',
                'setting up your pass key'
            ].map(s => s.toLowerCase());

            // --- new: keywords for security / security-check style dialogs ---
            const securityKeywords = [
                'security',
                'security check',
                'security checkup',
                'security sign in',
                'security warning',
                'security issue',
                'security verification',
                'check your security',
                'review your security',
                'security up',
                'security update',
                'account security',
                'security check completed',
                'security check completed'
            ].map(s => s.toLowerCase());

            let overallSucceeded = false;

            // Quick dedicated handler for security-like dialogs: prefer clicking "All good" / "Good" / "Looks good"
            const tryHandleSecurityDialog = async (): Promise<boolean> => {
                try {
                    // probe visible text quickly (DOM-safe)
                    const bodyText = await page.evaluate(() => {
                        const b = document.body;
                        if (!b) return '';
                        return (b as HTMLElement).innerText || b.textContent || '';
                    });
                    const lc = (bodyText || '').toLowerCase();

                    const foundKeyword = securityKeywords.some(k => lc.includes(k));
                    if (!foundKeyword) return false;

                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Detected security/check dialog by text probe — attempting to click "good" action.');

                    // 1) Playwright direct locators (preferred) for 'good' variants first
                    const goodLocators = [
                        'button:has-text("All good")',
                        'button:has-text("All Good")',
                        'button:has-text("all good")',
                        'button:has-text("Looks good")',
                        'button:has-text("Looks Good")',
                        'button:has-text("Looks good to me")',
                        'button:has-text("I\'m good")',
                        'button:has-text("I am good")',
                        'button:has-text("Good")',
                        'button:has-text("Good to go")',
                        'button[aria-label*="good"]',
                        'button[title*="good"]',
                        'input[type="button"][value*="Good"]',
                        'a:has-text("All good")',
                        'a:has-text("Good")'
                    ];
                    for (const sel of goodLocators) {
                        try {
                            const loc = page.locator(sel).first();
                            const cnt = await loc.count().catch(() => 0);
                            if (cnt > 0) {
                                const visible = await loc.isVisible().catch(() => false);
                                if (visible) {
                                    try {
                                        await loc.click({ force: true }).catch(() => {});
                                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Clicked "good" action via locator: ${sel}`);
                                        await this.bot.utils.wait(250);
                                        // verify if dialog still present
                                        const still = await page.evaluate((kws) => {
                                            const b = document.body;
                                            const text = b ? ((b as HTMLElement).innerText || b.textContent || '') : '';
                                            const lower = text.toLowerCase();
                                            for (const k of kws) if (lower.includes(k)) return true;
                                            return false;
                                        }, securityKeywords).catch(() => false);
                                        if (!still) return true;
                                    } catch (err) {
                                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Error clicking ${sel}: ${err}`, 'warn');
                                    }
                                }
                            }
                        } catch { /* per-locator */ }
                    }

                    // 2) DOM-evaluate fallback: find elements whose trimmed text contains 'good' (case-insensitive) and dispatch clicks
                    const clicked = await page.evaluate(() => {
                        const wantedKeywords = ['good', 'all good', 'looks good', "i'm good", 'i am good', 'good to go'];
                        const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], div[role="button"]'));
                        for (const el of candidates) {
                            try {
                                let txt = '';
                                if (el instanceof HTMLElement) {
                                    txt = el.innerText || (el.textContent || '');
                                } else if ((el as HTMLInputElement).value) {
                                    txt = (el as HTMLInputElement).value;
                                } else {
                                    txt = (el.textContent || '');
                                }
                                txt = txt.trim().toLowerCase();
                                if (!txt) continue;
                                for (const kw of wantedKeywords) {
                                    if (txt.includes(kw)) {
                                        try {
                                            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                                            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                                            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                                            return true;
                                        } catch {}
                                    }
                                }
                            } catch {}
                        }
                        return false;
                    }).catch(() => false);

                    if (clicked) {
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Clicked "good" action via DOM-evaluate fallback for security dialog');
                        await this.bot.utils.wait(200);
                        // confirm gone
                        const still = await page.evaluate((kws) => {
                            const b = document.body;
                            const text = b ? ((b as HTMLElement).innerText || b.textContent || '') : '';
                            const lower = text.toLowerCase();
                            for (const k of kws) if (lower.includes(k)) return true;
                            return false;
                        }, securityKeywords).catch(() => false);
                        if (!still) return true;
                    }

                    // 3) If still visible: hide ephemeral dialog containers (safe hide)
                    const hidden = await page.evaluate((containers: string[]) => {
                        let changed = false;
                        try {
                            for (const sel of containers) {
                                try {
                                    const nodes = Array.from(document.querySelectorAll(sel));
                                    for (const n of nodes) {
                                        try {
                                            const role = n.getAttribute ? n.getAttribute('role') : null;
                                            const cls = (n as any).className || '';
                                            const isEphemeral = (role === 'dialog' || role === 'alertdialog' || /popup|popUp|modal|overlay|security/i.test(cls));
                                            if (!isEphemeral) continue;
                                            if ((n as any).style) {
                                                try { (n as any).style.setProperty('pointer-events', 'none', 'important'); } catch {}
                                                try { (n as any).style.setProperty('display', 'none', 'important'); } catch {}
                                                try { (n as any).style.setProperty('opacity', '0', 'important'); } catch {}
                                            }
                                            try { n.setAttribute && n.setAttribute('aria-hidden', 'true'); } catch {}
                                            try { n.setAttribute && n.setAttribute('data-removed-by-bot', '1'); } catch {}
                                            changed = true;
                                        } catch {}
                                    }
                                } catch {}
                            }

                            // hide common backdrops
                            try {
                                const backdrops = Array.from(document.querySelectorAll('.modal-backdrop, .backdrop, .overlay, [data-modal-overlay]'));
                                for (const b of backdrops) {
                                    try { if ((b as any).style) (b as any).style.setProperty('display', 'none', 'important'); } catch {}
                                    try { if ((b as any).setAttribute) (b as any).setAttribute('data-removed-by-bot', '1'); } catch {}
                                    changed = true;
                                }
                            } catch {}

                            try { if (document.body && (document.body as any).style) (document.body as any).style.setProperty('pointer-events', 'auto', 'important'); } catch {}
                        } catch {}
                        return changed;
                    }, dialogContainers).catch(() => false);

                    if (hidden) {
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Safely hid security dialog containers as fallback (did not remove nodes).');
                        await this.bot.utils.wait(150);
                        return true;
                    }

                    // 4) final keyboard/body click fallback for security
                    try {
                        await page.keyboard.press('Escape').catch(() => {});
                        await page.mouse.click(5, 5).catch(() => {});
                        await page.mouse.click(20, 20).catch(() => {});
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Sent Escape and body-click fallbacks for security dialog');
                        await this.bot.utils.wait(200);
                    } catch {}

                    // final probe: is the security text gone?
                    const stillHas = await page.evaluate((kws) => {
                        const b = document.body;
                        const text = b ? ((b as HTMLElement).innerText || b.textContent || '') : '';
                        const lower = text.toLowerCase();
                        for (const k of kws) if (lower.includes(k)) return true;
                        return false;
                    }, securityKeywords).catch(() => false);

                    return !stillHas;
                } catch (err) {
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Security handler error: ${err}`, 'warn');
                    return false;
                }
            };

            // If we detect & handle a security dialog, prefer that path first.
            const securityHandled = await tryHandleSecurityDialog();
            if (securityHandled) {
                this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Security dialog handled (clicked "good" or hid).');
                overallSucceeded = true;
                await this.bot.utils.wait(200);
                return;
            }

            // Quick dedicated handler for passkey-like dialogs: prefer clicking "Cancel"
            const tryHandlePasskeyDialog = async (): Promise<boolean> => {
                try {
                    // probe visible text quickly (DOM-safe)
                    const bodyText = await page.evaluate(() => {
                        const b = document.body;
                        if (!b) return '';
                        // prefer innerText when present; fallback to textContent
                        // (this is pure runtime JS; TS warnings are avoided by using this code as-is)
                        return (b as HTMLElement).innerText || b.textContent || '';
                    });
                    const lc = (bodyText || '').toLowerCase();

                    const foundKeyword = passkeyKeywords.some(k => lc.includes(k));
                    if (!foundKeyword) return false;

                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Detected passkey/setup dialog by text probe — attempting to click Cancel.');

                    // 1) Playwright direct locators (preferred)
                    const cancelLocators = [
                        'button:has-text("Cancel")',
                        'button[aria-label="Cancel"]',
                        'button:has-text("Dismiss")',
                        'button[aria-label="Dismiss"]',
                        'button:has-text("No")',
                        'button:has-text("Close")',
                        'a:has-text("Cancel")',
                        'input[type="button"][value="Cancel"]',
                        'input[type="submit"][value="Cancel"]'
                    ];
                    for (const sel of cancelLocators) {
                        try {
                            const loc = page.locator(sel).first();
                            const cnt = await loc.count().catch(() => 0);
                            if (cnt > 0) {
                                const visible = await loc.isVisible().catch(() => false);
                                if (visible) {
                                    try {
                                        await loc.click({ force: true }).catch(() => {});
                                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Clicked Cancel via locator: ${sel}`);
                                        await this.bot.utils.wait(250);
                                        // verify if dialog still present
                                        const still = await page.evaluate((kws) => {
                                            const b = document.body;
                                            const text = b ? ((b as HTMLElement).innerText || b.textContent || '') : '';
                                            const lower = text.toLowerCase();
                                            for (const k of kws) if (lower.includes(k)) return true;
                                            return false;
                                        }, passkeyKeywords).catch(() => false);
                                        if (!still) return true;
                                    } catch (err) {
                                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Error clicking ${sel}: ${err}`, 'warn');
                                    }
                                }
                            }
                        } catch { /* per-locator */ }
                    }

                    // 2) DOM-evaluate fallback: find elements whose trimmed text is "Cancel" (case-insensitive) and dispatch clicks
                    const clicked = await page.evaluate(() => {
                        const wanted = ['cancel', 'dismiss', 'no', 'close'];
                        const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], div[role="button"]'));
                        for (const el of candidates) {
                            try {
                                // runtime-safe checks: prefer HTMLElement.innerText, else HTMLInputElement.value, else element.textContent
                                let txt = '';
                                if (el instanceof HTMLElement) {
                                    txt = el.innerText || (el.textContent || '');
                                } else if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) {
                                    txt = (el as HTMLInputElement).value || (el.textContent || '');
                                } else {
                                    txt = (el.textContent || '');
                                }
                                txt = txt.trim().toLowerCase();
                                if (!txt) continue;
                                if (wanted.includes(txt)) {
                                    try {
                                        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                                        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                                        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                                        return true;
                                    } catch {}
                                }
                            } catch {}
                        }
                        return false;
                    }).catch(() => false);

                    if (clicked) {
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Clicked Cancel via DOM-evaluate fallback for passkey dialog');
                        await this.bot.utils.wait(200);
                        // confirm gone
                        const still = await page.evaluate((kws) => {
                            const b = document.body;
                            const text = b ? ((b as HTMLElement).innerText || b.textContent || '') : '';
                            const lower = text.toLowerCase();
                            for (const k of kws) if (lower.includes(k)) return true;
                            return false;
                        }, passkeyKeywords).catch(() => false);
                        if (!still) return true;
                    }

                    // 3) If still visible: hide ephemeral dialog containers with a targeted passkey-safe approach
                    const hidden = await page.evaluate((containers: string[]) => {
                        let changed = false;
                        try {
                            for (const sel of containers) {
                                try {
                                    const nodes = Array.from(document.querySelectorAll(sel));
                                    for (const n of nodes) {
                                        try {
                                            const role = n.getAttribute ? n.getAttribute('role') : null;
                                            const cls = (n as any).className || '';
                                            const isEphemeral = (role === 'dialog' || role === 'alertdialog' || /popup|popUp|modal|overlay|security/i.test(cls));
                                            if (!isEphemeral) continue;
                                            if ((n as any).style) {
                                                try { (n as any).style.setProperty('pointer-events', 'none', 'important'); } catch {}
                                                try { (n as any).style.setProperty('display', 'none', 'important'); } catch {}
                                                try { (n as any).style.setProperty('opacity', '0', 'important'); } catch {}
                                            }
                                            try { n.setAttribute && n.setAttribute('aria-hidden', 'true'); } catch {}
                                            try { n.setAttribute && n.setAttribute('data-removed-by-bot', '1'); } catch {}
                                            changed = true;
                                        } catch {}
                                    }
                                } catch {}
                            }

                            // hide common backdrops
                            try {
                                const backdrops = Array.from(document.querySelectorAll('.modal-backdrop, .backdrop, .overlay, [data-modal-overlay]'));
                                for (const b of backdrops) {
                                    try { if ((b as any).style) (b as any).style.setProperty('display', 'none', 'important'); } catch {}
                                    try { if ((b as any).setAttribute) (b as any).setAttribute('data-removed-by-bot', '1'); } catch {}
                                    changed = true;
                                }
                            } catch {}

                            try { if (document.body && (document.body as any).style) (document.body as any).style.setProperty('pointer-events', 'auto', 'important'); } catch {}
                        } catch {}
                        return changed;
                    }, dialogContainers).catch(() => false);

                    if (hidden) {
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Safely hid passkey dialog containers as fallback (did not remove nodes).');
                        await this.bot.utils.wait(150);
                        return true;
                    }

                    // 4) final keyboard/body click fallback for passkey
                    try {
                        await page.keyboard.press('Escape').catch(() => {});
                        await page.mouse.click(5, 5).catch(() => {});
                        await page.mouse.click(20, 20).catch(() => {});
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Sent Escape and body-click fallbacks for passkey dialog');
                        await this.bot.utils.wait(200);
                    } catch {}

                    // final probe: is the passkey text gone?
                    const stillHas = await page.evaluate((kws) => {
                        const b = document.body;
                        const text = b ? ((b as HTMLElement).innerText || b.textContent || '') : '';
                        const lower = text.toLowerCase();
                        for (const k of kws) if (lower.includes(k)) return true;
                        return false;
                    }, passkeyKeywords).catch(() => false);

                    return !stillHas;
                } catch (err) {
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Passkey handler error: ${err}`, 'warn');
                    return false;
                }
            };

            // If we detect & handle a passkey/setup dialog, prefer that path next.
            const passkeyHandled = await tryHandlePasskeyDialog();
            if (passkeyHandled) {
                this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Passkey dialog handled (Cancel clicked or hidden).');
                overallSucceeded = true;
                await this.bot.utils.wait(200);
                return;
            }

            // If not passkey or not handled, continue with the original multi-attempt dismissal logic:
            for (let attempt = 0; attempt < 2; attempt++) {
                this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Dismiss attempt ${attempt + 1}/2`);

                // Quick probe: any visible popup matches?
                const hasPopup = await page.evaluate((params: { closeSel: string[]; dialogSel: string[] }) => {
                    const closeSel = params.closeSel || [];
                    const dialogSel = params.dialogSel || [];
                    try {
                        const selList = closeSel.concat(dialogSel);
                        for (const s of selList) {
                            try {
                                const nodes = Array.from(document.querySelectorAll(s));
                                for (const n of nodes) {
                                    try {
                                        const rect = (typeof (n as any).getBoundingClientRect === 'function') ? (n as any).getBoundingClientRect() : { width: 0, height: 0 };
                                        const cs = window.getComputedStyle ? window.getComputedStyle(n as Element) : null;
                                        const visibleRect = rect && rect.width > 0 && rect.height > 0;
                                        const visibleStyle = cs ? (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') : true;
                                        if (visibleRect && visibleStyle) return true;
                                    } catch { /* node-level */ }
                                }
                            } catch { /* selector-level */ }
                        }
                    } catch { /* swallow */ }
                    return false;
                }, { closeSel: closeSelectors, dialogSel: dialogContainers }).catch(() => false);

                if (!hasPopup) {
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'No welcome/popups detected (probe).');
                    overallSucceeded = true;
                    break;
                }

                // Popup exists: do up to 3 passes per attempt
                let attemptSucceeded = false;
                for (let pass = 0; pass < 3; pass++) {
                    // 1) Playwright forced clicks on known close selectors
                    for (const sel of closeSelectors) {
                        try {
                            const locator = page.locator(sel).first();
                            const cnt = await locator.count().catch(() => 0);
                            if (cnt > 0) {
                                const visible = await locator.isVisible().catch(() => false);
                                if (visible) {
                                    try {
                                        await locator.click({ force: true }).catch(() => {});
                                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Clicked close element via Playwright: ${sel}`);
                                        await this.bot.utils.wait(200);
                                    } catch (err) {
                                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Playwright click error for ${sel}: ${err}`, 'warn');
                                    }
                                }
                            }
                        } catch { /* ignore per-selector errors */ }
                    }

                    // 2) DOM-evaluate click fallback (dispatch mouse events)
                    try {
                        const clicked = await page.evaluate((params: { selList: string[] }) => {
                            try {
                                for (const s of params.selList) {
                                    try {
                                        const nodes = Array.from(document.querySelectorAll(s));
                                        for (const n of nodes) {
                                            try {
                                                const rect = (typeof (n as any).getBoundingClientRect === 'function') ? (n as any).getBoundingClientRect() : { width: 0, height: 0 };
                                                const cs = window.getComputedStyle ? window.getComputedStyle(n as Element) : null;
                                                const visibleRect = rect && rect.width > 0 && rect.height > 0;
                                                const visibleStyle = cs ? (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') : true;
                                                if (!visibleRect || !visibleStyle) continue;
                                                n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                                                n.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                                                n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                                                return true;
                                            } catch { /* node-level */ }
                                        }
                                    } catch { /* selector-level */ }
                                }
                            } catch {}
                            return false;
                        }, { selList: closeSelectors }).catch(() => false);

                        if (clicked) {
                            this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Clicked close via DOM-evaluate fallback');
                            await this.bot.utils.wait(150);
                        }
                    } catch (err) {
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `DOM-evaluate click failed: ${err}`, 'warn');
                    }

                    // 3) Safer hide of dialog containers (do not remove nodes)
                    try {
                        const hidden = await page.evaluate((params: { containers: string[] }) => {
                            const containers = params.containers || [];
                            let changed = false;
                            try {
                                for (const sel of containers) {
                                    try {
                                        const nodes = Array.from(document.querySelectorAll(sel));
                                        for (const n of nodes) {
                                            try {
                                                const role = (n as Element).getAttribute ? (n as Element).getAttribute('role') : null;
                                                const cls = (n as any).className || '';
                                                const isEphemeral = (role === 'dialog' || role === 'alertdialog' || /popup|popUp|modal|overlay|dashboardPopUp/i.test(cls));
                                                if (!isEphemeral) continue;
                                                try { if ((n as any).style) (n as any).style.setProperty('pointer-events', 'none', 'important'); } catch {}
                                                try { if ((n as any).style) (n as any).style.setProperty('display', 'none', 'important'); } catch {}
                                                try { if ((n as any).style) (n as any).style.setProperty('opacity', '0', 'important'); } catch {}
                                                try { if ((n as any).setAttribute) (n as any).setAttribute('aria-hidden', 'true'); } catch {}
                                                try { if ((n as any).setAttribute) (n as any).setAttribute('data-removed-by-bot', '1'); } catch {}
                                                changed = true;
                                            } catch {}
                                        }
                                    } catch {}
                                }

                                // hide common backdrops
                                try {
                                    const backdrops = Array.from(document.querySelectorAll('.modal-backdrop, .backdrop, .overlay, [data-modal-overlay]'));
                                    for (const b of backdrops) {
                                        try { if ((b as any).style) (b as any).style.setProperty('display', 'none', 'important'); } catch {}
                                        try { if ((b as any).setAttribute) (b as any).setAttribute('data-removed-by-bot', '1'); } catch {}
                                        changed = true;
                                    }
                                } catch {}

                                try { if (document.body && (document.body as any).style) (document.body as any).style.setProperty('pointer-events', 'auto', 'important'); } catch {}
                            } catch {}
                            return changed;
                        }, { containers: dialogContainers }).catch(() => false);

                        if (hidden) {
                            this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Safely hid ephemeral dialog containers (did not remove nodes)');
                            await this.bot.utils.wait(150);
                        }
                    } catch (err) {
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `DOM-evaluate hide attempt failed: ${err}`, 'warn');
                    }

                    // 4) Escape + small-body-click fallback
                    try {
                        await page.keyboard.press('Escape').catch(() => {});
                        await page.mouse.click(5, 5).catch(() => {});
                        await page.mouse.click(20, 20).catch(() => {});
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Sent Escape and body-click fallbacks');
                    } catch { /* ignore */ }

                    // Short pause between passes
                    await this.bot.utils.wait(300);

                    // Probe whether popups still exist; if none, mark success for this attempt
                    const stillHas = await page.evaluate((params: { closeSel: string[]; dialogSel: string[] }) => {
                        const closeSel = params.closeSel || [];
                        const dialogSel = params.dialogSel || [];
                        try {
                            const selList = closeSel.concat(dialogSel);
                            for (const s of selList) {
                                try {
                                    const nodes = Array.from(document.querySelectorAll(s));
                                    for (const n of nodes) {
                                        try {
                                            const rect = (typeof (n as any).getBoundingClientRect === 'function') ? (n as any).getBoundingClientRect() : { width: 0, height: 0 };
                                            const cs = window.getComputedStyle ? window.getComputedStyle(n as Element) : null;
                                            const visibleRect = rect && rect.width > 0 && rect.height > 0;
                                            const visibleStyle = cs ? (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') : true;
                                            if (visibleRect && visibleStyle) return true;
                                        } catch {}
                                    }
                                } catch {}
                            }
                        } catch {}
                        return false;
                    }, { closeSel: closeSelectors, dialogSel: dialogContainers }).catch(() => false);

                    if (!stillHas) {
                        attemptSucceeded = true;
                        break;
                    }
                } // end passes

                if (attemptSucceeded) {
                    overallSucceeded = true;
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Dismiss attempt ${attempt + 1} succeeded.`);
                    break;
                } else {
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Dismiss attempt ${attempt + 1} did not clear popup; ${attempt === 0 ? 'one more run will be tried.' : 'no more attempts.'}`, 'warn');
                    await this.bot.utils.wait(250);
                }
            } // end attempts

            if (!overallSucceeded) {
                this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Popup dismissal failed after 2 attempts — continuing without blocking.', 'warn');
            } else {
                await this.bot.utils.wait(200);
            }
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Error while dismissing welcome modal: ${err}`, 'warn');
        }
    }




    private async checkBingLoginStatus(page: Page): Promise<boolean> {
        try {
            await page.waitForSelector('#id_n', { timeout: 120000 })
            return true
        } catch (error) {
            return false
        }
    }

    private async checkAccountLocked(page: Page) {
        await this.bot.utils.wait(2000)
        const isLocked = await page.waitForSelector('#serviceAbuseLandingTitle', { state: 'visible', timeout: 120000 }).then(() => true).catch(() => false)
        if (isLocked) {
            // Get email from current context if possible
            let email = 'unknown';
            try {
                // Try to get email from page context or URL
                const currentUrl = page.url();
                const emailMatch = currentUrl.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
                if (emailMatch) email = emailMatch[0];
            } catch (e) {}

            this.emitError({
                type: 'ACCOUNT_LOCKED',
                email: email,
                message: 'Account has been locked! Remove from accounts.json',
                shouldRestartBrowsers: false // No need to restart for locked account
            });

            throw this.bot.log(this.bot.isMobile, 'CHECK-LOCKED', 'This account has been locked! Remove the account from "accounts.json" and restart!', 'error')
        }
    }

    /**
     * Centralized cleanup/marking when a login has permanently failed for an account.
     */
    private async handleFailedLogin(page: Page, email: string) {
        // Close all pages in the context (best-effort)
        try {
            const ctx = page.context()
            try {
                const pages = ctx.pages()
                for (const p of pages) {
                    try { if (!p.isClosed()) await p.close().catch(() => { }) } catch { }
                }
            } catch { /* ignore individual page close errors */ }

            // Also try closing the context itself if supported
            try { await (ctx as any).close().catch(() => { }) } catch { }

            this.bot.log(this.bot.isMobile, 'LOGIN', 'Closed pages/contexts after failed login (best-effort).')
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Failed to close pages/context: ${err}`, 'warn')
        }

        // Mark the account in memory (doLater flag)
        try {
            const cfg: any = this.bot.config || {}
            let marked = false
            if (Array.isArray(cfg.accounts)) {
                for (const acc of cfg.accounts) {
                    try {
                        if (acc && acc.email && acc.email.toLowerCase() === email.toLowerCase()) {
                            acc.doLater = true
                            marked = true
                            break
                        }
                    } catch { /* ignore */ }
                }
            }

            // fallback bot.accounts
            try {
                const accounts = (this.bot as any).accounts
                if (!marked && Array.isArray(accounts)) {
                    for (const acc of accounts) {
                        try {
                            if (acc && acc.email && acc.email.toLowerCase() === email.toLowerCase()) {
                                acc.doLater = true
                                marked = true
                                break
                            }
                        } catch { }
                    }
                }
            } catch { }

            if (marked) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Marked account ${email} with doLater = true (in-memory).`)
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Could not find account ${email} to mark doLater. Please mark it manually.`, 'warn')
            }

            // If the bot exposes a helper to mark accounts, call it (best-effort).
            try {
                const fn = (this.bot as any).markAccountDoLater || (this.bot as any).queueAccountForLater || (this.bot as any).skipAccount
                if (typeof fn === 'function') {
                    try { await fn.call(this.bot, email) } catch (e) { /* ignore errors */ }
                    this.bot.log(this.bot.isMobile, 'LOGIN', `Called bot helper to mark ${email} for later.`)
                }
            } catch { }
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Error while marking account doLater: ${err}`, 'warn')
        }

        // Finally, emit an error-level log so main process / operator sees it
        this.bot.log(this.bot.isMobile, 'LOGIN', `Login failed for ${email} after maximum retries. Account marked to try later.`, 'error')
    }

    // --------------- Mobile Access Token (Enhanced) ---------------
    async getMobileAccessToken(page: Page, email: string) {
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Mobile token attempt ${attempt}/${maxRetries}`);

                // Use the simpler approach - disable FIDO first
                await this.disableFido(page);

                const url = new URL(this.authBaseUrl);
                url.searchParams.set('response_type', 'code');
                url.searchParams.set('client_id', this.clientId);
                url.searchParams.set('redirect_uri', this.redirectUrl);
                url.searchParams.set('scope', this.scope);
                url.searchParams.set('state', crypto.randomBytes(16).toString('hex'));
                url.searchParams.set('access_type', 'offline_access');
                url.searchParams.set('login_hint', email);

                // Add a unique parameter to avoid caching
                url.searchParams.set('client-request-id', crypto.randomUUID());

                this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Navigating to authorization URL');

                // Use a simpler navigation approach
                await page.goto(url.href, {
                    waitUntil: 'domcontentloaded',
                    timeout: 120000
                });

                const start = Date.now();
                this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Authorizing mobile scope...');

                let code = '';
                const timeoutMs = 45000; // 45 seconds

                while (Date.now() - start < timeoutMs) {
                    // Handle any passkey prompts that might appear
                    await this.handlePasskeyPrompts(page, 'oauth');

                    const currentUrl = page.url();
                    const urlObj = new URL(currentUrl);

                    if (urlObj.hostname === 'login.live.com' && urlObj.pathname === '/oauth20_desktop.srf') {
                        code = urlObj.searchParams.get('code') || '';
                        if (code) {
                            this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Authorization code received successfully');
                            break;
                        }
                    }

                    // Check if we've been redirected to an Office or other Microsoft service
                    if (urlObj.searchParams.get('client_id') && urlObj.searchParams.get('client_id') !== this.clientId) {
                        this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Detected redirect to different client: ${urlObj.searchParams.get('client_id')}`, 'warn');

                        // Try to go back and restart
                        if (attempt < maxRetries) {
                            this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Going back and retrying...');
                            await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
                            await this.bot.utils.wait(2000);
                            break; // Break out of while loop to retry
                        }
                    }

                    await this.bot.utils.wait(1000);
                }

                if (!code) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-APP', `No authorization code received on attempt ${attempt}`, 'warn');

                    if (attempt < maxRetries) {
                        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
                        this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Waiting ${backoffMs}ms before retry...`);
                        await this.bot.utils.wait(backoffMs);
                        continue;
                    } else {
                        throw new Error('OAuth code not received in time');
                    }
                }

                // Exchange code for token
                const form = new URLSearchParams();
                form.append('grant_type', 'authorization_code');
                form.append('client_id', this.clientId);
                form.append('code', code);
                form.append('redirect_uri', this.redirectUrl);

                const req: AxiosRequestConfig = {
                    url: this.tokenUrl,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    data: form.toString(),
                    timeout: 120000
                };

                const resp = await this.bot.axios.request(req);
                const data: OAuth = resp.data;
                this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Authorized in ${Math.round((Date.now()-start)/1000)}s`);
                return data.access_token;

            } catch (error) {
                this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Attempt ${attempt} failed: ${error}`, 'warn');

                if (attempt < maxRetries) {
                    const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
                    this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Waiting ${backoffMs}ms before retry...`);
                    await this.bot.utils.wait(backoffMs);
                    continue;
                } else {
                    // Emit error notification for main process
                    this.emitError({
                        type: 'MOBILE_AUTH_FAILED',
                        email: email,
                        message: `Mobile authentication failed after ${maxRetries} attempts: ${error}`,
                        retryAfterMs: 10 * 60 * 1000, // 10 minutes
                        shouldRestartBrowsers: true
                    });

                    this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'All authorization attempts failed', 'error');

                    // Final fallback - try to continue without token
                    this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Using fallback - continuing without mobile token');
                    try {
                        await page.goto('https://rewards.bing.com/', {
                            waitUntil: 'domcontentloaded',
                            timeout: 120000
                        });
                    } catch (e) {
                        // Ignore navigation errors in fallback
                    }
                    return null;
                }
            }
        }

        return null;
    }

    /**
     * Disable FIDO support in login requests
     */
    private async disableFido(page: Page) {
        await page.route('**/GetCredentialType.srf*', (route) => {
            const postData = route.request().postData() || '{}';
            let body: any = {};
            try {
                body = JSON.parse(postData);
            } catch {
                body = {};
            }
            body.isFidoSupported = false;
            route.continue({ postData: JSON.stringify(body) });
        });
    }

    /**
     * Fetch code from Gmail — unchanged except it uses the page/context provided.
     */
    private async fetchCodeFromGmail(originalPage: Page, msPasswordHint?: string): Promise<string | null> {
        try {
            // detect gmail email from the MS page
            let gmailEmail: string | null = null
            try {
                const locator = originalPage.locator('text=/[A-Za-z0-9._%+-]+@gmail\\.com/').first()
                gmailEmail = await locator.textContent().catch(() => null)
            } catch { /* ignore */ }

            if (!gmailEmail) {
                const bodyText = await originalPage.textContent('body').catch(() => '')
                const mGuess = bodyText?.match(/\b[A-Za-z0-9._%+-]+@gmail\.com\b/)
                gmailEmail = mGuess ? mGuess[0] : null
            }

            if (!gmailEmail) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Unable to determine gmail address from Microsoft page', 'warn')
                return null
            }

            this.bot.log(this.bot.isMobile, 'LOGIN', `Detected gmail address: ${gmailEmail}`)

            // ----- Try to resolve an MS password (msPasswordHint or config) -----
            let msPassword: string | undefined = undefined
            if (msPasswordHint) { msPassword = msPasswordHint; this.bot.log(this.bot.isMobile, 'LOGIN', 'Using provided MS password hint (msPasswordHint).') }
            try {
                const accounts = (this.bot.config as any)?.accounts || (this.bot as any).accounts
                if (!msPassword && Array.isArray(accounts)) {
                    const match = accounts.find((a: any) => a?.email === gmailEmail)
                    if (match && match.password) { msPassword = match.password; this.bot.log(this.bot.isMobile, 'LOGIN', 'Using MS password from bot.config.accounts entry') }
                }
            } catch { /* ignore */ }

            // If the MS page offers a "Use your password" (or similar) path, prefer it when we have an MS password.
            // We check for common phrases/buttons that indicate a password path and try to click/fill the password input.
            try {
                // selectors/phrases to detect password alternative on MS sign-in UI
                const passwordOptionSelectors = [
                    'button:has-text("Use your password")',
                    'a:has-text("Use your password")',
                    'text=/use your password/i',
                    'button:has-text("Sign in with password")',
                    'text=/sign in with password/i',
                    'text=/use a password/i',
                    'text=/use password/i',
                    'text=/password/i' // last-resort catch (will be filtered further below)
                ]

                for (const sel of passwordOptionSelectors) {
                    const el = originalPage.locator(sel).first()
                    if (await el.isVisible().catch(() => false)) {
                        // If we don't have an MS password, don't click the option — let the caller fall back to Send code behavior.
                        if (!msPassword) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Found password-signin option (${sel}) but no MS password available — not using it.`, 'warn')
                            break
                        }

                        this.bot.log(this.bot.isMobile, 'LOGIN', `Found password-signin option (${sel}) — attempting password sign-in.`)
                        try {
                            await el.click().catch(() => { })
                            // wait a bit for the password field to show up
                            await originalPage.waitForTimeout(900)

                            // common password input selectors on MS pages
                            const pwdSelectors = ['input[type="password"]', 'input[name="passwd"]', 'input[name="password"]', 'input[id*="password"]']
                            let filled = false
                            for (const psel of pwdSelectors) {
                                try {
                                    const pwdEl = originalPage.locator(psel).first()
                                    if (await pwdEl.isVisible().catch(() => false)) {
                                        await originalPage.waitForTimeout((this.bot.config as any)?.passwordFillDelayMs ?? 400)
                                        await pwdEl.fill(msPassword).catch(() => { })
                                        await originalPage.waitForTimeout(300)
                                        // press Enter to submit password
                                        await originalPage.keyboard.press('Enter').catch(() => { })
                                        await originalPage.waitForTimeout(2200)
                                        filled = true
                                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Filled MS password and submitted (password path).')
                                        break
                                    }
                                } catch { /* ignore per-selector errors */ }
                            }

                            if (!filled) {
                                // Might be a slightly different flow: try to focus any visible password input and type
                                try {
                                    const anyPwd = await originalPage.locator('input[type="password"]').first()
                                    if (await anyPwd.isVisible().catch(() => false)) {
                                        await anyPwd.fill(msPassword).catch(() => { })
                                        await originalPage.keyboard.press('Enter').catch(() => { })
                                        await originalPage.waitForTimeout(2200)
                                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Filled MS password (fallback selector) and submitted.')
                                        filled = true
                                    }
                                } catch { /* ignore */ }
                            }

                            // If we successfully used password flow, we should not try to fetch a code from Gmail.
                            if (filled) {
                                // Caller expects a verification code string or null; since we used password auth, return null.
                                this.bot.log(this.bot.isMobile, 'LOGIN', 'Used MS password instead of Send code; skipping Gmail code fetch.')
                                return null
                            } else {
                                this.bot.log(this.bot.isMobile, 'LOGIN', 'Clicked password-signin option but did not find a password input to fill — will continue to email fallback.', 'warn')
                            }
                        } catch (pwErr) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Error while attempting password-signin flow: ${pwErr}`, 'warn')
                            // continue to normal email code path below
                        }

                        // whether succeeded or not, break out of selector loop to avoid double-clicking
                        break
                    }
                }
            } catch { /* ignore detection errors and continue to Gmail flow */ }

            // ----- existing gmail-password resolution (keeps your original gmailPassword logic) -----
            let gmailPassword: string | undefined = undefined
            if (msPasswordHint) { gmailPassword = msPasswordHint; this.bot.log(this.bot.isMobile, 'LOGIN', 'Using provided MS password as Gmail password hint (msPasswordHint).') }

            try {
                const configuredPw = (this.bot.config as any)?.gmailPasswords?.[gmailEmail]
                if (configuredPw) { gmailPassword = configuredPw; this.bot.log(this.bot.isMobile, 'LOGIN', 'Using Gmail password from bot.config.gmailPasswords') }
            } catch { /* ignore */ }

            try {
                const accounts = (this.bot.config as any)?.accounts || (this.bot as any).accounts
                if (!gmailPassword && Array.isArray(accounts)) {
                    const match = accounts.find((a: any) => a?.email === gmailEmail)
                    if (match && match.password) { gmailPassword = match.password; this.bot.log(this.bot.isMobile, 'LOGIN', 'Using Gmail password from bot.config.accounts entry') }
                }
            } catch { /* ignore */ }

            if (!gmailPassword) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'No Gmail password found in config or hints — will attempt to read inbox without logging in (if possible).', 'warn')
            }

            const context = originalPage.context()
            let gmailPage: Page | null = null
            let usedTempBrowser = false
            let tempBrowser: any = null

            try {
                if (context && typeof (context as any).newPage === 'function') { gmailPage = await (context as any).newPage() }
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Could not open new page in same context: ${err}`, 'warn'); gmailPage = null
            }

            if (!gmailPage) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Falling back to launching a temporary browser for Gmail (less ideal).', 'warn')
                tempBrowser = await (playwright as any).chromium.launch({ headless: this.bot.config.headless })
                const tempContext = await tempBrowser.newContext({ ignoreHTTPSErrors: true, viewport: null })
                gmailPage = await tempContext.newPage()
                usedTempBrowser = true
            }

            if (!gmailPage) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Unable to open a page for Gmail', 'error')
                if (tempBrowser) try { await tempBrowser.close() } catch { }
                return null
            }

            await gmailPage.goto('https://mail.google.com/', { waitUntil: 'domcontentloaded' })
            const navWaitMs = (this.bot.config as any)?.gmailNavWaitMs ?? DEFAULT_GMAIL_NAV_WAIT_MS
            await gmailPage.waitForTimeout(navWaitMs)

            try {
                const identifierSelector = 'input[type="email"], input[name="identifier"]'
                if (await gmailPage.locator(identifierSelector).first().isVisible().catch(() => false)) {
                    await gmailPage.fill(identifierSelector, gmailEmail)
                    await gmailPage.keyboard.press('Enter')
                    await gmailPage.waitForTimeout(1400)
                }
            } catch { /* ignore */ }

            try {
                const passwordSelector = 'input[type="password"], input[name="password"]'
                if (gmailPassword && await gmailPage.locator(passwordSelector).first().isVisible().catch(() => false)) {
                    await gmailPage.waitForTimeout((this.bot.config as any)?.passwordFillDelayMs ?? DEFAULT_PASSWORD_FILL_DELAY_MS)
                    await gmailPage.fill(passwordSelector, gmailPassword)
                    await gmailPage.waitForTimeout(300)
                    await gmailPage.keyboard.press('Enter')
                    await gmailPage.waitForTimeout(2200)
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Used resolved Gmail password to sign in to Gmail (UI).')
                } else if (!gmailPassword) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'No Gmail password provided — not attempting to sign in via UI (will try to read inbox if already logged in).', 'warn')
                }
            } catch { /* ignore */ }

            await gmailPage.waitForSelector('div[role="main"], div[role="list"]', { timeout: 120000 }).catch(() => null)
            await gmailPage.waitForTimeout(1200)

            const searchTerms = [
                'Microsoft',
                'code to sign in',
                'subject:("code to sign in")',
                'from:(account-security-noreply@accountprotection.microsoft.com)',
                'from:(no-reply@accountprotection.microsoft.com)',
                'subject:("Your Microsoft account")'
            ]

            let foundCode: string | null = null
            const overallRetries = (this.bot.config as any)?.gmailSearchRetries ?? 3
            const perSearchDelay = (this.bot.config as any)?.gmailSearchDelayMs ?? 1200

            const bodySelectors = [
                'div.a3s',
                'div.ii.gt',
                'div[aria-label="Message Body"]',
                'div[role="main"] article',
                'div[role="listitem"]',
                'article'
            ]

            const bodySelectorString = bodySelectors.join(',')

            const parseTimeOrZero = (timeStr: string | null) => {
                if (!timeStr) return 0
                const parsed = Date.parse(timeStr)
                return isNaN(parsed) ? 0 : parsed
            }

            for (let attempt = 0; attempt < overallRetries && !foundCode; attempt++) {
                for (const term of searchTerms) {
                    try {
                        await gmailPage.goto(`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(term)}`)
                        await gmailPage.waitForTimeout(perSearchDelay)

                        const threadsLocator = gmailPage.locator('tr.zA, div[role="listitem"]')
                        const threadsCount = await threadsLocator.count().catch(() => 0)

                        const threads: Array<{ index: number, ts: number }> = []
                        for (let i = 0; i < threadsCount; i++) {
                            try {
                                const row = threadsLocator.nth(i)
                                const visible = await row.isVisible().catch(() => false)
                                if (!visible) continue
                                const timeText = await row.evaluate((r: Element) => {
                                    const selCandidates = [
                                        'td.xW span',
                                        'span[title]',
                                        'abbr',
                                        'span[aria-label]'
                                    ]
                                    for (const s of selCandidates) {
                                        const el = r.querySelector(s)
                                        if (el) {
                                            const t = (el.getAttribute('title') || el.textContent || '').trim()
                                            if (t) return t
                                        }
                                    }
                                    return (r.textContent || '').slice(0, 200)
                                }).catch(() => '')
                                threads.push({ index: i, ts: parseTimeOrZero(timeText) })
                            } catch { /* ignore */ }
                        }

                        if (threads.length === 0 && threadsCount > 0) {
                            for (let i = 0; i < threadsCount; i++) threads.push({ index: i, ts: 0 })
                        }

                        threads.sort((a, b) => b.ts - a.ts)

                        for (const tinfo of threads) {
                            if (foundCode) break
                            try {
                                const threadRow = threadsLocator.nth(tinfo.index)
                                const canClick = await threadRow.isVisible().catch(() => false)
                                if (!canClick) continue
                                await threadRow.click().catch(() => { })
                                await gmailPage.waitForTimeout(900)
                                await gmailPage.waitForTimeout(400)

                                const messagesInThread = (await gmailPage.evaluate((bodySel) => {
                                    const nodes = Array.from(document.querySelectorAll(bodySel)).filter(n => n && n.textContent && n.textContent.trim().length > 0)
                                    return nodes.map((n: Element) => {
                                        let container: Element | null = (n.closest && n.closest('div.adn')) || n.closest('div[role="listitem"]') || n.closest('article') || n.parentElement
                                        let timeText = ''
                                        if (container) {
                                            const timeCandidates = [
                                                container.querySelector('span[title]'),
                                                container.querySelector('abbr'),
                                                container.querySelector('span[aria-label]'),
                                                container.querySelector('.g3 .xW span'),
                                                container.querySelector('.gH span')
                                            ]
                                            for (const el of timeCandidates) {
                                                if (el) {
                                                    timeText = (el.getAttribute('title') || el.textContent || '').trim()
                                                    if (timeText) break
                                                }
                                            }
                                        }
                                        return { text: n.textContent || '', timeText }
                                    })
                                }, bodySelectorString).catch(() => [])) as Array<{ text: string, timeText: string }>

                                const msgs = messagesInThread || []
                                if (Array.isArray(msgs) && msgs.length > 0) {
                                    let bestIdx = msgs.length - 1
                                    let bestTs = 0
                                    for (let mi = 0; mi < msgs.length; mi++) {
                                        const parsed = Date.parse(msgs[mi]?.timeText || '')
                                        if (!isNaN(parsed) && parsed > bestTs) { bestTs = parsed; bestIdx = mi }
                                    }
                                    const tryOrder: number[] = [bestIdx]
                                    for (let offset = 1; offset < msgs.length; offset++) {
                                        const after = bestIdx + offset
                                        const before = bestIdx - offset
                                        if (after < msgs.length) tryOrder.push(after)
                                        if (before >= 0) tryOrder.push(before)
                                    }
                                    for (const mi of tryOrder) {
                                        if (foundCode) break
                                        try {
                                            const bodyText = msgs[mi]?.text || ''
                                            if (!bodyText || bodyText.trim().length === 0) continue
                                            const candidate = this.extractCodeFromText(bodyText)
                                            if (candidate) { foundCode = candidate; break }
                                            const matches = bodyText.match(/\d{4,8}/g)
                                            if (matches && matches.length > 0) { foundCode = matches[matches.length - 1] || null; break }
                                        } catch { /* ignore per-message errors */ }
                                    }
                                } else {
                                    try {
                                        const bodyText = await gmailPage.evaluate(() => (document && document.body) ? (document.body.innerText || '') : '').catch(() => '')
                                        if (bodyText && bodyText.trim().length > 0) {
                                            const candidate = this.extractCodeFromText(bodyText)
                                            if (candidate) { foundCode = candidate; break }
                                            const matches = bodyText.match(/\d{4,8}/g)
                                            if (matches && matches.length > 0) { foundCode = matches[matches.length - 1] || null; break }
                                        }
                                    } catch { /* ignore */ }
                                }

                                await gmailPage.goBack().catch(() => null)
                                await gmailPage.waitForTimeout(400)
                            } catch { try { await gmailPage.goBack().catch(() => null) } catch { } }
                        }

                        if (foundCode) { this.bot.log(this.bot.isMobile, 'LOGIN', `Found candidate code in message body (term="${term}")`); break }
                    } catch { /* ignore term errors */ }
                }

                if (!foundCode) await gmailPage.waitForTimeout(Math.max(800, perSearchDelay * 1.5))
            }

            // fallback inbox check
            if (!foundCode) {
                try {
                    await gmailPage.goto('https://mail.google.com/mail/u/0/#inbox')
                    await gmailPage.waitForTimeout(1200)
                    const threadsLocator = gmailPage.locator('tr.zA, div[role="listitem"]')
                    const threadsCount = await threadsLocator.count().catch(() => 0)
                    const maxToCheck = Math.min(8, threadsCount)
                    const threads: Array<{ index: number, ts: number }> = []
                    for (let i = 0; i < threadsCount && threads.length < maxToCheck; i++) {
                        try {
                            const row = threadsLocator.nth(i)
                            const visible = await row.isVisible().catch(() => false)
                            if (!visible) continue
                            const timeText = await row.evaluate((r: Element) => {
                                const el = r.querySelector('span[title], abbr, span[aria-label]')
                                return (el && (el.getAttribute('title') || el.textContent)) ? (el.getAttribute('title') || el.textContent || '') : ''
                            }).catch(() => '')
                            threads.push({ index: i, ts: parseTimeOrZero(timeText) })
                        } catch { /* ignore */ }
                    }
                    if (threads.length === 0 && threadsCount > 0) {
                        for (let i = 0; i < Math.min(maxToCheck, threadsCount); i++) threads.push({ index: i, ts: 0 })
                    }
                    threads.sort((a, b) => b.ts - a.ts)

                    for (const tinfo of threads) {
                        if (foundCode) break
                        try {
                            const thread = threadsLocator.nth(tinfo.index)
                            if (!await thread.isVisible().catch(() => false)) continue
                            await thread.click().catch(() => {})
                            await gmailPage.waitForTimeout(800)

                            const messagesInThread = (await gmailPage.evaluate((bodySel) => {
                                const nodes = Array.from(document.querySelectorAll(bodySel)).filter(n => n && n.textContent && n.textContent.trim().length > 0)
                                return nodes.map((n: Element) => {
                                    let container: Element | null = (n.closest && n.closest('div.adn')) || n.closest('div[role="listitem"]') || n.closest('article') || n.parentElement
                                    let timeText = ''
                                    if (container) {
                                        const timeCandidates = [
                                            container.querySelector('span[title]'),
                                            container.querySelector('abbr'),
                                            container.querySelector('span[aria-label]'),
                                            container.querySelector('.g3 .xW span'),
                                            container.querySelector('.gH span')
                                        ]
                                        for (const el of timeCandidates) {
                                            if (el) { timeText = (el.getAttribute('title') || el.textContent || '').trim(); if (timeText) break }
                                        }
                                    }
                                    return { text: n.textContent || '', timeText }
                                })
                            }, bodySelectorString).catch(() => [])) as Array<{ text: string, timeText: string }>

                            const msgs = messagesInThread || []
                            if (Array.isArray(msgs) && msgs.length > 0) {
                                let bestIdx = msgs.length - 1
                                let bestTs = 0
                                for (let mi = 0; mi < msgs.length; mi++) {
                                    const parsed = Date.parse(msgs[mi]?.timeText || '')
                                    if (!isNaN(parsed) && parsed > bestTs) { bestTs = parsed; bestIdx = mi }
                                }
                                const tryOrder: number[] = [bestIdx]
                                for (let offset = 1; offset < msgs.length; offset++) {
                                    const after = bestIdx + offset
                                    const before = bestIdx - offset
                                    if (after < msgs.length) tryOrder.push(after)
                                    if (before >= 0) tryOrder.push(before)
                                }
                                for (const mi of tryOrder) {
                                    if (foundCode) break
                                    const bodyText = msgs[mi]?.text || ''
                                    if (!bodyText) continue
                                    const candidate = this.extractCodeFromText(bodyText)
                                    if (candidate) { foundCode = candidate; break }
                                    const matches = bodyText.match(/\d{4,8}/g)
                                    if (matches && matches.length > 0) { foundCode = matches[matches.length - 1] || null; break }
                                }
                            } else {
                                const pageText = await gmailPage.evaluate(() => (document && document.body) ? (document.body.innerText || '') : '').catch(() => '')
                                if (pageText && pageText.trim().length > 0) {
                                    const candidate = this.extractCodeFromText(pageText)
                                    if (candidate) { foundCode = candidate; break }
                                    const matches = pageText.match(/\d{4,8}/g)
                                    if (matches && matches.length > 0) { foundCode = matches[matches.length - 1] || null; break }
                                }
                            }

                            await gmailPage.goBack().catch(() => null)
                            await gmailPage.waitForTimeout(300)
                        } catch { /* ignore thread errors */ }
                    }
                } catch { /* ignore fallback errors */ }
            }

            try { await gmailPage.close() } catch { }
            if (usedTempBrowser && tempBrowser) { try { await tempBrowser.close() } catch { } }

            if (foundCode) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Found verification code in Gmail: ${foundCode}`)
                return foundCode
            }

            this.bot.log(this.bot.isMobile, 'LOGIN', 'No verification code found in Gmail', 'warn')
            return null
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `fetchCodeFromGmail error: ${err}`, 'error')
            return null
        }
    }

    private extractCodeFromText(bodyText: string): string | null {
        if (!bodyText || typeof bodyText !== 'string') return null
        const txt = bodyText.replace(/\u00A0/g, ' ').replace(/\r/g, ' ').replace(/\n+/g, '\n')
        const patterns: Array<{ re: RegExp, name: string }> = [
            { re: /Microsoft\s+verification\s+code\s*(?:is|:)?\s*[:\-\s]*([0-9]{4,8})/i, name: 'Microsoft verification code' },
            { re: /your\s+single[-\s]?use\s+code\s*(?:is|:)?\s*[:\-\s]*([0-9]{4,8})/i, name: 'your single-use code is' },
            { re: /single[-\s]?use\s+code\s*(?:is|:)?\s*[:\-\s]*([0-9]{4,8})/i, name: 'single-use code' },
            { re: /your\s+one[-\s]?time\s+code\s*(?:is|:)?\s*[:\-\s]*([0-9]{4,8})/i, name: 'one-time code' },
            { re: /verification\s+code\s*(?:is|:)?\s*[:\-\s]*([0-9]{4,8})/i, name: 'verification code' },
            { re: /(?:code\s*(?:is|:)|is:)\s*([0-9]{4,8})\b/i, name: 'code is (fallback)' },
            { re: /code[:\s]*([0-9]{4,8})/i, name: 'code:' }
        ]
        for (const p of patterns) {
            const m = txt.match(p.re)
            if (m && m[1]) {
                const code = m[1].trim()
                if (/^\d{4,8}$/.test(code)) return code
            }
        }
        return null
    }
}
