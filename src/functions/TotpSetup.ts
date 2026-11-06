import fs from 'fs'
import path from 'path'
import * as OTPAuth from 'otpauth'
import type { Locator, Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type { Account } from '../interface/Account'
import { CodeLogin } from '../browser/auth/methods/GetACodeLogin'
import { EmailLogin } from '../browser/auth/methods/EmailLogin'
import { errorDiagnostic } from '../util/ErrorDiagnostic'
import { getAccountsFileOverride } from '../util/Load'

const SECURITY_URL = 'https://account.live.com/proofs/Manage/additional'
const PENDING_FILE = 'accounts.totp-pending.json'

// Text-based matching survives Microsoft's frequent markup changes better than ids.
// Covers both the modern (account.microsoft.com) and legacy (account.live.com proofs) wording.
const TEXT = {
    addMethod:
        /add a new way to sign in|add another way to sign in|add (a )?(new )?sign-in method|add a way to (sign in|verify)|add (a )?method/i,
    useApp: /^\s*use an app\s*$|authenticator app|^\s*an app\s*$|identity verification app/i,
    differentApp: /different authenticator app|set up a different app|another (authenticator )?app|other authenticator/i,
    cantScan:
        /can.?t scan|cannot scan|unable to scan|enter (the )?(code|key) manually|manual(ly)? entry|set up.*(without|no).*(camera|scan)|pair.*manually/i,
    next: /^\s*(next|verify|continue|confirm)\s*$/i,
    done: /^\s*(done|finish|ok|got it|close)\s*$/i,
    sendCode: /^\s*(send code|send|get code)\s*$/i,
    codeError: /incorrect|isn.t right|wasn.t right|didn.t work|try again|invalid code|wrong code/i
}

// Legacy account.live.com/proofs ids, tried before falling back to text matching
const LEGACY = {
    addProof: '#AddProofLink, a[data-mp-control="AddProofItem.AddProofLink"]'
}

const CODE_INPUTS =
    '#iTOTPField, input[id*="TOTP" i], input[type="tel"], input[maxlength="6"], input[name*="code" i], input[aria-label*="code" i], input[id*="code" i]'

// Legacy /proofs/Add confirm step: the verification field and its primary (Next) button
const LEGACY_CONFIRM = {
    action: '#otherAuthenticatorSetupAction'
}

export class TotpSetup {
    private codeLogin: CodeLogin
    private emailLogin: EmailLogin

    constructor(private bot: MicrosoftRewardsBot) {
        this.codeLogin = new CodeLogin(bot)
        this.emailLogin = new EmailLogin(bot)
    }

    private log(message: string) {
        this.bot.logger.info(this.bot.isMobile, 'TOTP-SETUP', message)
    }

    private async settle(page: Page) {
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
        await this.bot.utils.wait(this.bot.utils.randomNumber(1500, 3500))
    }

    private async findByText(page: Page, pattern: RegExp): Promise<Locator | null> {
        const candidates = [
            page.getByRole('button', { name: pattern }),
            page.getByRole('link', { name: pattern }),
            page.getByRole('radio', { name: pattern }),
            page.getByRole('menuitem', { name: pattern }),
            page.getByRole('option', { name: pattern }),
            page.locator('[data-testid="tile"]').filter({ hasText: pattern }),
            page.getByText(pattern)
        ]
        for (const candidate of candidates) {
            const el = candidate.first()
            if (await el.isVisible().catch(() => false)) return el
        }
        return null
    }

    private async clickText(page: Page, pattern: RegExp, label: string): Promise<boolean> {
        const el = await this.findByText(page, pattern)
        if (!el) return false
        await this.bot.utils.wait(this.bot.utils.humanClickDelay())
        await el.click({ timeout: 8000 }).catch(() => {})
        this.log(`Clicked "${label}"`)
        await this.settle(page)
        return true
    }

    private async visible(page: Page, selector: string): Promise<boolean> {
        return page
            .locator(selector)
            .first()
            .isVisible()
            .catch(() => false)
    }

    // Clicks a CSS selector if present (used for stable legacy ids before falling back to text)
    private async clickSelector(page: Page, selector: string, label: string): Promise<boolean> {
        const el = page.locator(selector).first()
        if (!(await el.isVisible().catch(() => false))) return false
        await this.bot.utils.wait(this.bot.utils.humanClickDelay())
        await el.click({ timeout: 8000 }).catch(() => {})
        this.log(`Clicked "${label}"`)
        await this.settle(page)
        return true
    }

    // Debug only: dumps the current page so one run reveals the whole flow even if a later step fails
    private async snap(page: Page, name: string): Promise<void> {
        const dir = process.env.MR_TOTP_DEBUG_DIR
        if (!dir) return
        try {
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, `${name}.html`), await page.content())
            await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(() => {})
            this.log(`[debug] snapped ${name} (${new URL(page.url()).pathname})`)
        } catch {
            /* ignore */
        }
    }

    // Microsoft asks to re-verify before changing security info: password, email code, or both
    private async passIdentityCheck(page: Page, account: Account) {
        let requestedAt = Date.now()

        for (let step = 0; step < 8; step++) {
            const host = new URL(page.url()).hostname

            if (await this.visible(page, 'input[type="password"]')) {
                this.log('Identity check: password')
                await this.emailLogin.enterPassword(page, account.password)
                await this.settle(page)
                continue
            }

            // Classic account.live.com picker: radio list + "complete the hidden part of the email"
            if (await this.visible(page, '#iProofEmail')) {
                this.log('Identity check: confirming email address')
                await page.click('#iProofEmail').catch(() => {})
                await this.bot.utils.typeLikeHuman(page, account.email.split('@')[0] as string, 'text')
                requestedAt = Date.now()
                const sent =
                    (await this.visible(page, '#iSelectProofAction')) &&
                    (await this.bot.browser.utils.ghostClick(page, '#iSelectProofAction'))
                if (!sent) await page.keyboard.press('Enter')
                await this.settle(page)
                continue
            }

            const proofRadio = page.locator('#iProofList input[type="radio"], input[name="proof"]').first()
            if (await proofRadio.isVisible().catch(() => false)) {
                this.log('Identity check: choosing email proof')
                await proofRadio.click().catch(() => {})
                await this.settle(page)
                continue
            }

            // New UI: tile picker - prefer the email tile
            const emailTile = page.locator('[data-testid="tile"]').filter({ hasText: /@|email/i }).first()
            if (await emailTile.isVisible().catch(() => false)) {
                this.log('Identity check: sending code to email')
                requestedAt = Date.now()
                await this.bot.utils.wait(this.bot.utils.humanClickDelay())
                await emailTile.click().catch(() => {})
                await this.settle(page)
                continue
            }

            const codeInput =
                (await this.visible(page, '#iOttText')) ||
                (await this.visible(page, '[data-testid="codeInputWrapper"]')) ||
                (await this.visible(page, 'input[name="otc"]'))
            if (codeInput) {
                this.log('Identity check: entering email code')
                await this.codeLogin.handle(page, account, requestedAt)
                if (await this.visible(page, '#iVerifyCodeAction')) {
                    await this.bot.browser.utils.ghostClick(page, '#iVerifyCodeAction')
                }
                await this.settle(page)
                continue
            }

            const sendButton = await this.findByText(page, TEXT.sendCode)
            if (sendButton && (host.startsWith('login.') || host === 'account.live.com')) {
                requestedAt = Date.now()
                await this.clickText(page, TEXT.sendCode, 'Send code')
                continue
            }

            return
        }
    }

    private async extractSecret(page: Page): Promise<string | null> {
        const html = await page.content().catch(() => '')
        const uri = html.match(/otpauth:\/\/totp\/[^"'<\s]+/i)?.[0]
        if (uri) {
            const secret = new URL(uri.replace(/&amp;/g, '&')).searchParams.get('secret')
            if (secret) return secret
        }

        const text = await page.innerText('body').catch(() => '')
        const labelled = text.match(/secret key\s*:?\s*([a-z2-7]{4}(?:\s?[a-z2-7]{4}){3,15})/i)?.[1]
        if (labelled) return labelled.replace(/\s+/g, '').toUpperCase()

        // Microsoft shows the key as space-separated groups of 4 base32 characters
        const grouped = text.match(/\b([a-z2-7]{4}(?: [a-z2-7]{4}){3,15})\b/i)?.[1]
        return grouped ? grouped.replace(/\s+/g, '').toUpperCase() : null
    }

    private async currentCode(secret: string): Promise<string> {
        // Roll to a fresh 30s window if too little time is left to type + submit before it expires
        const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30)
        if (secondsLeft < 12) await this.bot.utils.wait((secondsLeft + 1) * 1000)
        return new OTPAuth.TOTP({ secret, digits: 6 }).generate()
    }

    private async confirmCode(page: Page, secret: string): Promise<boolean> {
        for (let attempt = 1; attempt <= 2; attempt++) {
            const input = page.locator(CODE_INPUTS).filter({ visible: true }).first()
            if (!(await input.isVisible().catch(() => false))) {
                // Some versions show the key first and the code box after "Next"
                if (!(await this.clickText(page, TEXT.next, 'Next'))) return false
                continue
            }

            // A person would open the app and read the code
            await this.bot.utils.wait(this.bot.utils.randomNumber(4000, 9000))
            const code = await this.currentCode(secret)

            await input.click().catch(() => {})
            await page.keyboard.press('Control+A')
            await page.keyboard.press('Backspace')
            await this.bot.utils.typeLikeHuman(page, code, 'code')

            const submitted =
                (await this.clickSelector(page, LEGACY_CONFIRM.action, 'Verify (Next)')) ||
                (await this.clickText(page, TEXT.next, 'Next'))
            if (!submitted) await page.keyboard.press('Enter')
            await this.settle(page)

            const stillOnInput = await input.isVisible().catch(() => false)
            const body = await page.innerText('body').catch(() => '')
            if (!stillOnInput && !TEXT.codeError.test(body)) return true

            this.bot.logger.warn(this.bot.isMobile, 'TOTP-SETUP', `Code not accepted (attempt ${attempt}/2)`)
            await this.bot.utils.wait(31_000)
        }
        return false
    }

    /** Adds an authenticator app to the logged-in account and returns its secret (null on failure). */
    async enable(page: Page, account: Account, dryRun = false): Promise<string | null> {
        try {
            this.log('Opening security settings')
            await page.goto(SECURITY_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
            await this.settle(page)
            await this.passIdentityCheck(page, account)
            await this.snap(page, '01-manage')

            // Legacy account.live.com uses #AddProofLink; modern UI uses the text button
            const addedMethod =
                (await this.clickSelector(page, LEGACY.addProof, 'Add another way to sign in')) ||
                (await this.clickText(page, TEXT.addMethod, 'Add a new way to sign in or verify'))
            if (!addedMethod) throw new Error('"Add a new way to sign in" option not found')
            await this.snap(page, '02-after-addproof')

            if (!(await this.clickText(page, TEXT.useApp, 'Use an app'))) {
                throw new Error('"Use an app" option not found')
            }
            await this.passIdentityCheck(page, account)
            await this.snap(page, '03-after-useapp')

            // Microsoft pushes its own app first; the generic flow exposes the secret key
            await this.clickText(page, TEXT.differentApp, 'Set up a different authenticator app')
            await this.snap(page, '04-after-diffapp')
            await this.clickText(page, TEXT.cantScan, "I can't scan the bar code")
            await this.snap(page, '05-after-cantscan')

            const secret = await this.extractSecret(page)
            if (!secret) throw new Error('Secret key not found on page')
            this.log('Secret key captured')

            if (dryRun) {
                this.log('Dry run: stopping before confirming - nothing was added to the account')
                return secret
            }

            // Persist before confirming so a crash can never leave an app attached with a lost secret
            this.savePending(account.email, secret)

            if (!(await this.confirmCode(page, secret))) throw new Error('Microsoft did not accept the generated code')

            await this.clickText(page, TEXT.done, 'Done')
            this.log('Authenticator app added')
            return secret
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            this.bot.logger.error(this.bot.isMobile, 'TOTP-SETUP', `${account.email}: ${err.message}`)
            await errorDiagnostic(page, err).catch(() => {})
            return null
        }
    }

    private projectFiles(name: string): string[] {
        const root = process.cwd()
        return [path.join(root, name), path.join(root, 'src', name), path.join(root, 'dist', name)]
    }

    private savePending(email: string, secret: string) {
        const file = path.join(process.cwd(), PENDING_FILE)
        const pending = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {}
        pending[email] = { secret, createdAt: new Date().toISOString() }
        fs.writeFileSync(file, JSON.stringify(pending, null, 4))
    }

    /** Writes totpSecret into every accounts file that lists this email. */
    saveSecret(email: string, secret: string) {
        const override = getAccountsFileOverride()
        const file = process.argv.includes('-dev') ? 'accounts.dev.json' : 'accounts.json'
        const targets = override ? [override] : this.projectFiles(file)
        let written = 0

        for (const accountsFile of targets.filter(f => fs.existsSync(f))) {
            const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf-8')) as Account[]
            const target = accounts.find(a => a.email.toLowerCase() === email.toLowerCase())
            if (!target) continue
            target.totpSecret = secret
            fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 4))
            written++
        }

        if (!written) throw new Error(`No accounts file lists ${email}; secret kept in ${PENDING_FILE}`)

        const pendingFile = path.join(process.cwd(), PENDING_FILE)
        if (fs.existsSync(pendingFile)) {
            const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'))
            for (const key of Object.keys(pending)) {
                if (key.toLowerCase() === email.toLowerCase()) delete pending[key]
            }
            if (Object.keys(pending).length) fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 4))
            else fs.rmSync(pendingFile)
        }
        this.log(`Saved totpSecret to ${written} accounts file(s)`)
    }
}
