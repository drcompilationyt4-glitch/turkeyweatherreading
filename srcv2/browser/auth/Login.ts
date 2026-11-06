import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../index'
import { saveSessionData } from '../../util/Load'

import { MobileAccessLogin } from './methods/MobileAccessLogin'
import { EmailLogin } from './methods/EmailLogin'
import { PasswordlessLogin } from './methods/PasswordlessLogin'
import { TotpLogin } from './methods/Totp2FALogin'
import { CodeLogin } from './methods/GetACodeLogin'
import { RecoveryLogin } from './methods/RecoveryEmailLogin'
import { canPromptForInput } from './methods/LoginUtils'

import type { Account } from '../../interface/Account'

type LoginState =
    | 'EMAIL_INPUT'
    | 'PASSWORD_INPUT'
    | 'FOOTER_ACTION'
    | 'SIGN_IN_METHOD_PICKER'
    | 'PASSWORDLESS_SEND_CODE'
    | 'EMAIL_VERIFICATION_INPUT'
    | 'PASSKEY_ERROR'
    | 'PASSKEY_VIDEO'
    | 'KMSI_PROMPT'
    | 'LOGGED_IN'
    | 'RECOVERY_EMAIL_INPUT'
    | 'ACCOUNT_LOCKED'
    | 'ERROR_ALERT'
    | '2FA_TOTP'
    | 'LOGIN_PASSWORDLESS'
    | 'OTP_CODE_ENTRY'
    | 'PAGE_TRANSITION'
    | 'UNKNOWN'
    | 'CHROMEWEBDATA_ERROR'
    | 'INTERRUPT'
    | 'SESSION_ERROR'

// The URL is kept with the state so a handler can skip work if the page moved on after detection
type LoginStateSnapshot = { state: LoginState; url: string }

type SignInMethodType = 'PASSWORD' | 'TOTP' | 'EMAIL' | 'AUTHENTICATOR' | 'PASSKEY' | 'UNKNOWN'

interface SignInMethodOption {
    index: number
    label: string
    signature: string
}

const LOGIN_SELECTORS = {
    primaryButton: 'button[data-testid="primaryButton"]',
    secondaryButton: 'button[data-testid="secondaryButton"]',
    footerAction: '[data-testid="viewFooter"] [role="button"]',
    signInTile: '[data-testid="tile"]',
    emailIconOld: 'img[data-testid="accessibleImg"][src*="picker_verify_email"]',
    passwordlessOptionOld: 'img[data-testid="accessibleImg"][src*="picker_remote_ngc"]',
    recoveryEmail: '[data-testid="proof-confirmation"]',
    emailVerificationInput: 'input#proof-confirmation-email-input',
    accountLocked: '#serviceAbuseLandingTitle',
    errorAlert: 'div[role="alert"]',
    passwordEntry: '[data-testid="passwordEntry"]',
    emailEntry: 'input#usernameEntry',
    kmsiVideo: '[data-testid="kmsiVideo"]',
    passKeyVideo: '[data-testid="biometricVideo"]',
    passKeyError: '[data-testid="registrationImg"]',
    passwordlessCheck: '[data-testid="deviceShieldCheckmarkVideo"]',
    passwordlessNumber: '[data-testid="displaySign"]',
    totpInput: 'input[name="otc"]',
    totpInputOld: 'form[name="OneTimeCodeViewForm"]',
    identityBanner: '[data-testid="identityBanner"]',
    otpCodeEntry: '[data-testid="codeEntry"]',
    backButton: '#back-button',
    bingProfile: '#id_n',
    otpInput: 'div[data-testid="codeEntry"]',
    requestToken: 'input[name="__RequestVerificationToken"]',
    requestTokenMeta: 'meta[name="__RequestVerificationToken"]'
} as const

// Whole login (all states) gives up after this, so a wedged page can't hold a worker forever
const LOGIN_DEADLINE_MS = 10 * 60 * 1000

export class Login {
    emailLogin: EmailLogin
    passwordlessLogin: PasswordlessLogin
    totp2FALogin: TotpLogin
    codeLogin: CodeLogin
    recoveryLogin: RecoveryLogin

    private readonly selectors = LOGIN_SELECTORS

    // Set once the Authenticator push method is chosen, so its landing page isn't mistaken for a code-send page
    private passwordlessMethodSelected = false
    // Set once the authenticator-code tile is chosen, so the following code screen is filled from totpSecret
    private totpMethodSelected = false

    private readonly loginUrl = 'https://rewards.bing.com/createuser?idru=%2F&userScenarioId=anonsignin'

    constructor(private bot: MicrosoftRewardsBot) {
        this.emailLogin = new EmailLogin(this.bot)
        this.passwordlessLogin = new PasswordlessLogin(this.bot)
        this.totp2FALogin = new TotpLogin(this.bot)
        this.codeLogin = new CodeLogin(this.bot)
        this.recoveryLogin = new RecoveryLogin(this.bot)
    }

    async login(page: Page, account: Account) {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting login process')

            await page
                .goto(this.loginUrl, {
                    waitUntil: 'domcontentloaded'
                })
                .catch(() => {})
            await this.bot.utils.wait(2000)
            await this.bot.browser.utils.reloadBadPage(page)
            await this.bot.browser.utils.disableFido(page)

            const maxIterations = 25
            const deadline = Date.now() + LOGIN_DEADLINE_MS
            let iteration = 0
            let previousState: LoginState = 'UNKNOWN'
            let sameStateCount = 0
            this.passwordlessMethodSelected = false
            this.totpMethodSelected = false

            while (iteration < maxIterations) {
                if (page.isClosed()) throw new Error('Page closed unexpectedly')
                if (Date.now() > deadline) throw new Error('Login timeout: exceeded 10 minute deadline')

                iteration++
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `State check iteration ${iteration}/${maxIterations}`)

                const snapshot = await this.detectCurrentState(page, account)
                const state = snapshot.state
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Current state: ${state}`)

                // A mid-redirect read is not a real state - wait it out without spending an iteration
                if (state === 'PAGE_TRANSITION') {
                    iteration--
                    await this.bot.utils.wait(500)
                    continue
                }

                if (state !== previousState && previousState !== 'UNKNOWN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `State transition: ${previousState} → ${state}`)
                }

                if (state === previousState && state !== 'LOGGED_IN' && state !== 'UNKNOWN') {
                    sameStateCount++
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN',
                        `Same state count: ${sameStateCount}/4 for state "${state}"`
                    )
                    if (sameStateCount >= 4) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN',
                            `Stuck in state "${state}" for 4 loops, returning to Rewards`
                        )
                        await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
                        await this.bot.utils.wait(3000)
                        sameStateCount = 0
                        previousState = 'UNKNOWN'
                        continue
                    }
                } else {
                    sameStateCount = 0
                }
                previousState = state

                if (state === 'LOGGED_IN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Successfully logged in')
                    break
                }

                const shouldContinue = await this.handleState(snapshot, page, account)
                if (!shouldContinue) {
                    throw new Error(`Login failed or aborted at state: ${state}`)
                }

                await this.bot.utils.wait(1000)
            }

            if (iteration >= maxIterations) {
                throw new Error('Login timeout: exceeded maximum iterations')
            }

            await this.finalizeLogin(page, account.email)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN',
                `Fatal error: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    // Polls briefly: a page torn down mid-read (redirect) becomes PAGE_TRANSITION instead of a crash or a wrong state
    private async detectCurrentState(page: Page, account?: Account): Promise<LoginStateSnapshot> {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

        const deadline = Date.now() + 3000
        do {
            const url = page.url()
            let state: LoginState
            try {
                state = await this.detectPageState(page, new URL(url), account)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (page.isClosed() || !/Execution context was destroyed|Cannot find context with specified id/i.test(message)) {
                    throw error
                }
                state = 'PAGE_TRANSITION'
            }

            if (page.url() === url && state !== 'UNKNOWN' && state !== 'PAGE_TRANSITION') {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DETECT-STATE',
                    `${state} at ${new URL(url).hostname}${new URL(url).pathname}`
                )
                return { state, url }
            }
            await this.bot.utils.wait(150)
        } while (Date.now() < deadline)

        return { state: 'UNKNOWN', url: page.url() }
    }

    private async detectPageState(page: Page, url: URL, account?: Account): Promise<LoginState> {
        if (url.hostname === 'chromewebdata') {
            this.bot.logger.warn(this.bot.isMobile, 'DETECT-STATE', 'Detected chromewebdata error page')
            return 'CHROMEWEBDATA_ERROR'
        }

        // One in-page pass reads every selector together instead of a round-trip per selector
        const controls = await page.evaluate(selectors => {
            const visible: Record<string, boolean> = {}
            let footerText = ''
            for (const [name, selector] of Object.entries(selectors)) {
                const element = document.querySelector<HTMLElement>(selector)
                const style = element ? getComputedStyle(element) : null
                visible[name] = Boolean(
                    element &&
                        style?.visibility !== 'hidden' &&
                        style?.display !== 'none' &&
                        element.getClientRects().length
                )
                if (name === 'footerAction') footerText = element?.innerText ?? ''
            }
            const description = Array.from(
                document.querySelectorAll<HTMLElement>(
                    '[data-testid="subtitle"], [data-testid="description"], #oneTimeCodeDescription'
                )
            )
                .map(element => element.innerText)
                .join(' ')
            const bodyText = (document.body?.innerText ?? '').slice(0, 5000).toLowerCase()
            return {
                visible,
                footerText,
                description,
                tooManyRequests: bodyText.includes('too many requests') || bodyText.includes('banyak permintaan')
            }
        }, LOGIN_SELECTORS)

        if (page.url() !== url.href) return 'PAGE_TRANSITION'
        if (controls.tooManyRequests) return 'ERROR_ALERT'
        if (controls.visible.accountLocked) return 'ACCOUNT_LOCKED'

        if (url.hostname === 'rewards.bing.com' || url.hostname === 'account.microsoft.com') {
            return 'LOGGED_IN'
        }

        const stateChecks: Array<[keyof typeof LOGIN_SELECTORS, LoginState]> = [
            ['errorAlert', 'ERROR_ALERT'],
            ['passwordEntry', 'PASSWORD_INPUT'],
            ['emailEntry', 'EMAIL_INPUT'],
            ['recoveryEmail', 'RECOVERY_EMAIL_INPUT'],
            ['emailVerificationInput', 'EMAIL_VERIFICATION_INPUT'],
            ['kmsiVideo', 'KMSI_PROMPT'],
            ['passKeyVideo', 'PASSKEY_VIDEO'],
            ['passKeyError', 'PASSKEY_ERROR'],
            ['signInTile', 'SIGN_IN_METHOD_PICKER'],
            ['passwordlessOptionOld', 'SIGN_IN_METHOD_PICKER'],
            ['emailIconOld', 'SIGN_IN_METHOD_PICKER'],
            ['passwordlessCheck', 'LOGIN_PASSWORDLESS'],
            ['passwordlessNumber', 'LOGIN_PASSWORDLESS'],
            ['totpInput', '2FA_TOTP'],
            ['totpInputOld', '2FA_TOTP'],
            ['otpCodeEntry', 'OTP_CODE_ENTRY'],
            ['otpInput', 'OTP_CODE_ENTRY']
        ]
        const results: Array<LoginState | null> = stateChecks.map(([name, state]) =>
            controls.visible[name] ? state : null
        )

        // An authenticator-code screen reuses the code-entry component; fill it from totpSecret rather than escape it
        const description = controls.description
        const looksLikeAuthenticatorCode =
            /authenticator|verification app|authentication app/i.test(description) && !/@/.test(description)
        if (
            account?.totpSecret &&
            results.includes('OTP_CODE_ENTRY') &&
            (this.totpMethodSelected || looksLikeAuthenticatorCode)
        ) {
            for (let index = 0; index < results.length; index++) {
                if (results[index] === 'OTP_CODE_ENTRY') results[index] = '2FA_TOTP'
            }
        }

        const onSignInPage =
            (url.hostname === 'login.live.com' || url.hostname === 'login.microsoft.com') &&
            !this.isPasskeyEnrollment(url)
        const { identityBanner, primaryButton, passwordEntry, footerAction } = controls.visible

        // "Get a code" page - tell a generic "other ways" footer apart from a footer that names a specific proof
        if (
            onSignInPage &&
            identityBanner &&
            primaryButton &&
            !passwordEntry &&
            !results.includes('2FA_TOTP') &&
            !results.includes('RECOVERY_EMAIL_INPUT') &&
            !results.includes('EMAIL_VERIFICATION_INPUT')
        ) {
            const footer = controls.footerText.replace(/\s+/g, ' ').trim()
            const footerTargetsSpecificProof =
                /[\w.+*-]+@[\w.*-]+\.[a-z]{2,}/i.test(footer) ||
                /(?:\+?\d|[*xX])(?:[\d\s().*xX-]{4,})(?:\d|[*xX])/.test(footer)

            results.push(
                footerAction && !footerTargetsSpecificProof && !this.passwordlessMethodSelected
                    ? 'FOOTER_ACTION'
                    : 'PASSWORDLESS_SEND_CODE'
            )
        }

        let foundStates = results.filter((s): s is LoginState => s !== null)

        if (foundStates.length === 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'No matching states found')
            return this.fallbackState(url)
        }

        if (foundStates.includes('ERROR_ALERT')) {
            if (url.hostname !== 'login.live.com' || foundStates.includes('2FA_TOTP')) {
                foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
            }
            if (foundStates.includes('ERROR_ALERT')) return 'ERROR_ALERT'
        }

        if (foundStates.length === 0) return this.fallbackState(url)

        const priorities: LoginState[] = [
            'ACCOUNT_LOCKED',
            'PASSKEY_VIDEO',
            'PASSKEY_ERROR',
            'KMSI_PROMPT',
            'LOGIN_PASSWORDLESS',
            'PASSWORD_INPUT',
            'EMAIL_INPUT',
            'EMAIL_VERIFICATION_INPUT',
            'RECOVERY_EMAIL_INPUT',
            'SIGN_IN_METHOD_PICKER',
            'OTP_CODE_ENTRY',
            'FOOTER_ACTION',
            'PASSWORDLESS_SEND_CODE',
            '2FA_TOTP'
        ]

        for (const priority of priorities) {
            if (foundStates.includes(priority)) return priority
        }

        return foundStates[0] ?? 'UNKNOWN'
    }

    private isPasskeyEnrollment(url: URL): boolean {
        return url.pathname.toLowerCase().includes('/fido/create')
    }

    // Post-password pages (terms update, passkey setup, security prompts) that sit between sign-in and Rewards
    private fallbackState(url: URL): LoginState {
        if (url.hostname === 'account.live.com') {
            return url.pathname.toLowerCase().includes('error') ? 'SESSION_ERROR' : 'INTERRUPT'
        }
        if (this.isPasskeyEnrollment(url)) return 'INTERRUPT'
        return 'UNKNOWN'
    }

    private async clickInterruptButton(page: Page): Promise<string | null> {
        const skip = /^\s*(skip( for now)?|cancel|not now|no thanks|maybe later|remind me later|close)\s*$/i
        const proceed = /^\s*(next|continue|accept|i accept|agree|i agree|yes|ok|got it|done)\s*$/i
        const candidates = [
            page.getByRole('button', { name: skip }),
            page.getByRole('link', { name: skip }),
            page.getByRole('button', { name: proceed })
        ]

        for (const candidate of candidates) {
            const el = candidate.first()
            if (!(await el.isVisible().catch(() => false))) continue

            const label =
                (await el.innerText().catch(() => '')).trim() ||
                ((await el.getAttribute('value').catch(() => null)) ?? 'button')
            await el.click({ timeout: 5000 }).catch(() => {})
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
            return label
        }
        return null
    }

    // Reads each visible method tile: its text plus structural attributes (ids, img src, svg path data)
    private async getSignInMethodOptions(page: Page): Promise<SignInMethodOption[]> {
        const tiles = page.locator(this.selectors.signInTile)
        const count = await tiles.count().catch(() => 0)
        const options = await Promise.all(
            Array.from({ length: count }, async (_, index): Promise<SignInMethodOption | null> => {
                const tile = tiles.nth(index)
                if (!(await tile.isVisible().catch(() => false))) return null

                const metadata = await tile
                    .evaluate(element => {
                        const nodes = [element, ...Array.from(element.querySelectorAll('*'))]
                        const structural = new Set(['id', 'name', 'src', 'data-testid', 'data-value', 'data-bind', 'd'])
                        const accessibleText = nodes
                            .flatMap(node => ['aria-label', 'title', 'alt'].map(name => node.getAttribute(name) ?? ''))
                            .filter(Boolean)
                            .join(' ')
                        const attributes = nodes
                            .flatMap(node =>
                                Array.from(node.attributes)
                                    .filter(attribute => structural.has(attribute.name))
                                    .map(attribute => `${attribute.name}=${attribute.value}`)
                            )
                            .join(' ')
                        return { text: element.textContent ?? '', accessibleText, attributes }
                    })
                    .catch(() => null)
                if (!metadata) return null

                return {
                    index,
                    label: `${metadata.text} ${metadata.accessibleText}`.replace(/\s+/g, ' ').trim(),
                    signature: metadata.attributes.replace(/\s+/g, ' ').trim().toLowerCase()
                }
            })
        )
        return options.filter((option): option is SignInMethodOption => option !== null)
    }

    // Classify by icon/attribute signature (language-independent), with a label fallback for the code tile
    private classifySignInMethod(option: SignInMethodOption): SignInMethodType {
        const { signature, label } = option

        if (signature.includes('m5.25 4h13.5a3.25') || signature.includes('picker_verify_email')) return 'EMAIL'
        if (signature.includes('m11.78 10.22a.75')) return 'PASSWORD'
        if (/picker_fido|passkey|fido|m18 16\.66a3\.51/.test(signature)) return 'PASSKEY'
        if (/phone[\s_-]*app[\s_-]*otp|\btotp\b/.test(signature)) return 'TOTP'
        // "Use a verification code" - push approval and email/SMS tiles are excluded
        if (
            /verification code|code from (an|your|the) (authenticator )?app|authenticator app code/i.test(label) &&
            !/@|approve|request|text|sms/i.test(label)
        ) {
            return 'TOTP'
        }
        if (
            /remote[\s_-]*ngc|picker_remote_ngc|phone[\s_-]*app[\s_-]*notification|push[\s_-]*notification|m15\.75 2c16\.99 2 18 3/.test(
                signature
            )
        ) {
            return 'AUTHENTICATOR'
        }
        return 'UNKNOWN'
    }

    private async clickSignInMethodOption(page: Page, option: SignInMethodOption): Promise<boolean> {
        await this.bot.utils.wait(this.bot.utils.humanClickDelay())
        if (await this.bot.browser.utils.ghostClick(page, `${this.selectors.signInTile} >> nth=${option.index}`)) {
            return true
        }
        return page
            .locator(this.selectors.signInTile)
            .nth(option.index)
            .click({ timeout: 5000 })
            .then(() => true)
            .catch(() => false)
    }

    // Labels can contain the masked email/phone - redact before logging
    private describeSignInMethods(options: SignInMethodOption[]): string {
        return options
            .map(option =>
                `${this.classifySignInMethod(option)}:"${option.label
                    .replace(/[\w.+*-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>')
                    .replace(/\+?\d[\d\s().*-]{5,}\d/g, '<phone>')
                    .slice(0, 40)}"`
            )
            .join(' | ')
    }

    // Waits until detection settles on a state the caller accepts, or gives up after the timeout
    private async waitForState(
        page: Page,
        account: Account,
        accept: (state: LoginState) => boolean,
        timeoutMs = 15000
    ): Promise<LoginState | null> {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            const detected = await this.detectCurrentState(page, account)
            if (page.url() === detected.url && accept(detected.state)) return detected.state
            await this.bot.utils.wait(300)
        }
        return null
    }

    private async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page
            .waitForSelector(selector, { state: 'visible', timeout: 200 })
            .then(() => true)
            .catch(() => false)
    }

    // On a server nobody can read an emailed code - only request one when something here can (IMAP, terminal, relay)
    private canReceiveEmailCode(account: Account): boolean {
        const imap = !!account.emailCode?.appPassword && account.emailCode?.enabled !== false
        if (imap || canPromptForInput()) return true

        this.bot.logger.error(
            this.bot.isMobile,
            'LOGIN',
            'Microsoft wants an email code but nothing on this machine can read it - not requesting one. ' +
                'Add a totpSecret (npm run setup-totp) or emailCode.appPassword for this account.'
        )
        return false
    }

    private async handleState(
        { state, url: detectedUrl }: LoginStateSnapshot,
        page: Page,
        account: Account
    ): Promise<boolean> {
        // The page moved on after detection - re-detect instead of acting on a stale state
        if (page.url() !== detectedUrl) {
            this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', 'Page changed after state detection; checking again')
            return true
        }
        this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `Processing state: ${state}`)

        switch (state) {
            case 'ACCOUNT_LOCKED': {
                const msg = 'This account has been locked! Remove from config and restart!'
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', msg)
                throw new Error(msg)
            }

            case 'ERROR_ALERT': {
                const alertEl = page.locator(this.selectors.errorAlert).first()
                let errorMsg = await alertEl.innerText().catch(() => '')

                if (!errorMsg) {
                    const bodyText = await page.innerText('body').catch(() => '')
                    if (
                        bodyText.toLowerCase().includes('too many requests') ||
                        bodyText.toLowerCase().includes('banyak permintaan')
                    ) {
                        errorMsg = 'Too many requests'
                    } else {
                        errorMsg = 'Unknown Error (Check screenshot)'
                    }
                }

                this.bot.logger.error(this.bot.isMobile, 'LOGIN', `Account error detected: ${errorMsg}`)

                throw new Error(`Microsoft login error: ${errorMsg}`)
            }

            case 'LOGGED_IN':
                return true

            case 'EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Entering email')
                await this.bot.utils.wait(this.bot.utils.humanFormInputDelay())
                await this.emailLogin.enterEmail(page, account.email)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after email entry')
                })
                await this.bot.utils.wait(this.bot.utils.humanNavigationDelay())
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Email entered successfully')
                return true
            }

            case 'PASSWORD_INPUT': {
                if (!account.password) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN',
                        'Password page shown but no password configured; returning to sign-in methods'
                    )
                    if (await this.checkSelector(page, this.selectors.backButton)) {
                        await this.bot.browser.utils.ghostClick(page, this.selectors.backButton)
                        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                        return true
                    }
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'No way back to sign-in methods')
                    return false
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Entering password')
                await this.bot.utils.wait(this.bot.utils.humanFormInputDelay())
                await this.emailLogin.enterPassword(page, account.password)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after password entry')
                })
                await this.bot.utils.wait(this.bot.utils.humanNavigationDelay())
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Password entered successfully')
                return true
            }

            // "Get a code" page with a generic "Other ways to sign in" footer - open the method picker
            case 'FOOTER_ACTION': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Opening "Other ways to sign in"')
                await this.bot.utils.wait(this.bot.utils.humanClickDelay())
                if (!(await this.bot.browser.utils.ghostClick(page, this.selectors.footerAction))) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not open alternative sign-in methods')
                    return false
                }
                this.passwordlessMethodSelected = false
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                return true
            }

            // "Get a code" page whose only action sends a code (or an Authenticator request we already chose)
            case 'PASSWORDLESS_SEND_CODE': {
                if (this.passwordlessMethodSelected) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Sending Microsoft Authenticator request')
                    await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                    return true
                }

                // With a password there is a better route than burning an email code - go back to the methods
                if (account.password && (await this.checkSelector(page, this.selectors.backButton))) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Skipping "Send code"; returning to sign-in methods')
                    await this.bot.browser.utils.ghostClick(page, this.selectors.backButton)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                    return true
                }

                if (!this.canReceiveEmailCode(account)) return false

                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Requesting email code')
                const codeRequestedAt = Date.now()
                await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                await this.codeLogin.handle(page, account, codeRequestedAt)
                return true
            }

            // "Sign in another way" - password, then authenticator code, then email code, then push approval
            case 'SIGN_IN_METHOD_PICKER': {
                const options = await this.getSignInMethodOptions(page)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', `Sign-in methods: ${this.describeSignInMethods(options)}`)

                const pick = (type: SignInMethodType) =>
                    options.find(option => this.classifySignInMethod(option) === type)
                const passwordOption = pick('PASSWORD')
                const totpOption = pick('TOTP')
                const emailOption = pick('EMAIL')
                const authenticatorOption = pick('AUTHENTICATOR')

                if (account.password && passwordOption) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting "Use your password"')
                    this.passwordlessMethodSelected = false
                    if (!(await this.clickSignInMethodOption(page, passwordOption))) return false
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                    return true
                }

                // An authenticator code needs no mailbox and no one to approve anything
                if (account.totpSecret && totpOption) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting "Use a verification code" (authenticator)')
                    this.totpMethodSelected = true
                    if (!(await this.clickSignInMethodOption(page, totpOption))) return false
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                    return true
                }

                const emailIconOldFound = await this.checkSelector(page, this.selectors.emailIconOld)
                if ((emailOption || emailIconOldFound) && this.canReceiveEmailCode(account)) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting "Send a code to email"')
                    this.passwordlessMethodSelected = false
                    const codeRequestedAt = Date.now()
                    const clicked = emailOption
                        ? await this.clickSignInMethodOption(page, emailOption)
                        : await this.bot.browser.utils.ghostClick(page, this.selectors.emailIconOld)
                    if (!clicked) return false
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                    await this.codeLogin.handle(page, account, codeRequestedAt)
                    return true
                }

                // Push approval needs a person with the phone, so it is the last resort
                const passwordlessOptionOldFound = await this.checkSelector(page, this.selectors.passwordlessOptionOld)
                if (authenticatorOption || passwordlessOptionOldFound) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting Microsoft Authenticator approval')
                    this.passwordlessMethodSelected = true
                    const clicked = authenticatorOption
                        ? await this.clickSignInMethodOption(page, authenticatorOption)
                        : await this.bot.browser.utils.ghostClick(page, this.selectors.passwordlessOptionOld)
                    if (!clicked) {
                        this.passwordlessMethodSelected = false
                        return false
                    }
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                    return true
                }

                this.bot.logger.error(this.bot.isMobile, 'LOGIN', 'No supported sign-in method on the picker')
                return false
            }

            // "Verify your email" - with a password, try the footer alternatives before spending an email code
            case 'EMAIL_VERIFICATION_INPUT': {
                if (account.password) {
                    const footerSelector = `${this.selectors.footerAction}:visible`
                    const footerCount = await page
                        .locator(footerSelector)
                        .count()
                        .catch(() => 0)

                    for (let index = 0; index < footerCount; index++) {
                        await this.bot.utils.wait(this.bot.utils.humanClickDelay())
                        if (!(await this.bot.browser.utils.ghostClick(page, `${footerSelector} >> nth=${index}`))) {
                            continue
                        }

                        const nextState = await this.waitForState(
                            page,
                            account,
                            next => next !== 'EMAIL_VERIFICATION_INPUT' && next !== 'UNKNOWN' && next !== 'PAGE_TRANSITION'
                        )
                        if (!nextState) continue

                        // Anything but another code screen is progress - let the main loop take it from here
                        if (nextState !== 'OTP_CODE_ENTRY') {
                            this.bot.logger.info(this.bot.isMobile, 'LOGIN', `Email verification bypassed via ${nextState}`)
                            return true
                        }

                        if (!(await this.checkSelector(page, this.selectors.backButton))) break
                        await this.bot.browser.utils.ghostClick(page, this.selectors.backButton)
                        if (!(await this.waitForState(page, account, next => next === 'EMAIL_VERIFICATION_INPUT'))) break
                    }
                }

                if (!this.canReceiveEmailCode(account)) return false

                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Verifying by email code')
                await this.codeLogin.handle(page, account, Date.now())
                return true
            }

            case 'RECOVERY_EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery email input detected')
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout on recovery page')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Initiating recovery email handler')
                await this.recoveryLogin.handle(page, account?.recoveryEmail)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery email handler completed successfully')
                return true
            }

            case 'CHROMEWEBDATA_ERROR': {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'chromewebdata error detected, attempting recovery')
                // Try Rewards first, then login.live.com - and only call it recovered if we left the error page
                for (const target of [this.bot.config.baseURL, 'https://login.live.com/']) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `Navigating to ${target}`)
                    const response = await page
                        .goto(target, { waitUntil: 'domcontentloaded', timeout: 10000 })
                        .catch(() => null)
                    await this.bot.utils.wait(3000)

                    const stillBroken =
                        page.url().startsWith('chrome-error:') ||
                        new URL(page.url()).hostname === 'chromewebdata' ||
                        (response !== null && !response.ok() && response.status() >= 500)
                    if (!stillBroken) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery navigation successful')
                        return true
                    }
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', `Recovery via ${target} failed`)
                }
                // Let the loop retry; the stuck-state guard / deadline stop it if the network is really down
                return true
            }

            case '2FA_TOTP': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP 2FA authentication required')
                await this.totp2FALogin.handle(page, account.totpSecret)
                this.totpMethodSelected = false
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP 2FA handler completed successfully')
                return true
            }

            case 'KMSI_PROMPT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Accepting KMSI prompt')
                await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after KMSI acceptance')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'KMSI prompt accepted')
                return true
            }

            case 'PASSKEY_VIDEO':
            case 'PASSKEY_ERROR': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Skipping Passkey prompt')
                await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after Passkey skip')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passkey prompt skipped')
                return true
            }

            case 'LOGIN_PASSWORDLESS': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Handling passwordless authentication')
                await this.passwordlessLogin.handle(page)
                this.passwordlessMethodSelected = false
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after passwordless auth')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passwordless authentication completed successfully')
                return true
            }

            // An email-code screen we did not ask for - try the alternate-method footer, then Back, so no code is spent
            case 'OTP_CODE_ENTRY': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Code entry page detected; looking for another sign-in method')

                if (await this.checkSelector(page, this.selectors.footerAction)) {
                    await this.bot.utils.wait(this.bot.utils.humanClickDelay())
                    if (await this.bot.browser.utils.ghostClick(page, this.selectors.footerAction)) {
                        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

                        // Only count it as escaped if the code page is actually gone
                        if (!(await this.checkSelector(page, this.selectors.otpCodeEntry))) {
                            this.passwordlessMethodSelected =
                                (await this.checkSelector(page, this.selectors.passwordlessCheck)) ||
                                (await this.checkSelector(page, this.selectors.passwordlessNumber))
                            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Left the code entry page')
                            return true
                        }
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Footer did not leave the code page; trying Back')
                    }
                }

                this.passwordlessMethodSelected = false
                if (await this.checkSelector(page, this.selectors.backButton)) {
                    await this.bot.browser.utils.ghostClick(page, this.selectors.backButton)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Back button clicked')
                    return true
                }

                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'No way off the code entry page')
                return false
            }

            case 'PAGE_TRANSITION':
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Redirect still in progress, waiting')
                return true

            case 'INTERRUPT': {
                const url = new URL(page.url())
                const heading = (
                    await page.locator('h1').first().innerText({ timeout: 1000 }).catch(() => '')
                ).trim()
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    `Interrupt page at ${url.hostname}${url.pathname}${heading ? ` ("${heading}")` : ''}`
                )

                const clicked = await this.clickInterruptButton(page)
                if (clicked) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `Clicked "${clicked}" on interrupt page`)
                    return true
                }

                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'No dismiss button found, returning to Rewards')
                await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
                return true
            }

            case 'SESSION_ERROR': {
                const url = new URL(page.url())
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `Microsoft error page at ${url.hostname}${url.pathname}, returning to Rewards`
                )
                await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
                await this.bot.utils.wait(2000)
                return true
            }

            case 'UNKNOWN': {
                const url = new URL(page.url())
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `Unknown state at ${url.hostname}${url.pathname}, waiting`
                )
                return true
            }

            default:
                this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `Unhandled state: ${state}, continuing`)
                return true
        }
    }

    private async finalizeLogin(page: Page, email: string) {
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Finalizing login')

        await page.goto(this.bot.config.baseURL, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

        // Handle cookie popup - click Reject if it appears
        await this.bot.browser.utils.tryDismissAllMessages(page)

        const loginRewardsSuccess = new URL(page.url()).hostname === 'rewards.bing.com'
        if (loginRewardsSuccess) {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Logged into Microsoft Rewards successfully')
        } else {
            this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not verify Rewards Dashboard, assuming login valid')
        }

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting Bing session verification')
        await this.verifyBingSession(page)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting rewards session verification')
        await this.getRewardsSession(page)

        const browser = page.context()
        const cookies = await browser.cookies()
        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Retrieved ${cookies.length} cookies`)
        await saveSessionData(this.bot.config.sessionPath, cookies, email, this.bot.isMobile)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Login completed, session saved')
    }

    async verifyBingSession(page: Page) {
        const url =
            'https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F'
        const loopMax = 5

        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Verifying Bing session')

        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `Verification loop ${i + 1}/${loopMax}`)

                const { state } = await this.detectCurrentState(page)
                if (state === 'PASSKEY_ERROR') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Dismissing Passkey error state')
                    await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                }

                const u = new URL(page.url())
                const atBingHome = u.hostname === 'www.bing.com' && u.pathname === '/'
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-BING',
                    `At Bing home: ${atBingHome} (${u.hostname}${u.pathname})`
                )

                if (atBingHome) {
                    await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

                    // Bing's page model names the signed-in user; the profile element is the fallback (and mobile lacks it)
                    const modelSignedIn = await page
                        .evaluate(() => {
                            const model = (window as unknown as { _model?: { UserType?: string; UserEmail?: string } })
                                ._model
                            return model?.UserType === 'msa' || Boolean(model?.UserEmail)
                        })
                        .catch(() => false)
                    const signedIn =
                        modelSignedIn ||
                        (await page
                            .waitForSelector(this.selectors.bingProfile, { timeout: 3000 })
                            .then(() => true)
                            .catch(() => false))

                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN-BING',
                        `Signed in: ${signedIn} (page model: ${modelSignedIn})`
                    )

                    if (signedIn || this.bot.isMobile) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Bing session verified successfully')
                        return
                    }
                }

                await this.bot.utils.wait(1000)
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-BING', 'Could not verify Bing session, continuing anyway')
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-BING',
                `Verification error: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async getRewardsSession(page: Page) {
        const loopMax = 5

        this.bot.logger.info(this.bot.isMobile, 'GET-REWARD-SESSION', 'Fetching request token')

        try {
            await page
                .goto(`${this.bot.config.baseURL}?_=${Date.now()}`, { waitUntil: 'networkidle', timeout: 10000 })
                .catch(() => {})

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'GET-REWARD-SESSION', `Token fetch loop ${i + 1}/${loopMax}`)

                const u = new URL(page.url())
                const atRewardHome = u.hostname === 'rewards.bing.com' && u.pathname === '/'

                if (atRewardHome) {
                    await this.bot.browser.utils.tryDismissAllMessages(page)

                    const html = await page.content()
                    const $ = await this.bot.browser.utils.loadInCheerio(html)

                    // Check which version of the dashboard is being used, disable requestToken req on new dash
                    const isModernDashboard = $('section#dailyset').length > 0 // Only on new UI and on dashboard/overview page

                    if (isModernDashboard) {
                        this.bot.rewardsVersion = 'modern'

                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'GET-REWARD-SESSION',
                            'Modern Rewards dashboard detected. This script version may not fully support it.'
                        )

                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'GET-REWARD-SESSION',
                            'RequestToken disabled for this session (expected behavior).'
                        )
                    }

                    const token =
                        $(this.selectors.requestToken).attr('value') ??
                        $(this.selectors.requestTokenMeta).attr('content') ??
                        null

                    if (token) {
                        this.bot.requestToken = token
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'GET-REWARD-SESSION',
                            `Request token retrieved: ${token.substring(0, 10)}...`
                        )
                        return
                    }

                    this.bot.logger.debug(this.bot.isMobile, 'GET-REWARD-SESSION', 'Token not found on page')
                } else {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'GET-REWARD-SESSION',
                        `Not at reward home: ${u.hostname}${u.pathname}`
                    )
                }

                await this.bot.utils.wait(1000)
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                'No RequestVerificationToken found, some activities may not work'
            )
        } catch (error) {
            throw this.bot.logger.error(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `Fatal error: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    async getAppAccessToken(page: Page, email: string) {
        this.bot.logger.info(this.bot.isMobile, 'GET-APP-TOKEN', 'Requesting mobile access token')
        return await new MobileAccessLogin(this.bot, page).get(email)
    }
}