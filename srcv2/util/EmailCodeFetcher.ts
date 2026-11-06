import { ImapFlow, type ListResponse } from 'imapflow'
import { simpleParser } from 'mailparser'

export interface EmailCodeFetcherOptions {
    // Mailbox that receives the Microsoft code (usually the account email itself)
    user: string
    // Passwords to try in order (e.g. Gmail app password first, then the account password)
    passwords: string[]
    host?: string
    port?: number
    // Optional hint like "da*****@gmail.com" or the full Microsoft account email, used to prefer the right mail
    targetHint?: string
    log?: (level: 'info' | 'warn' | 'debug', message: string) => void
}

export interface WaitForCodeOptions {
    // Only mails received at/after this moment are considered (ms epoch)
    notBefore: number
    timeoutMs?: number
    pollIntervalMs?: number
    // Codes already tried and rejected - never returned again
    exclude?: Set<string>
    // Called once when the wait is halfway with nothing found (e.g. to click "resend code")
    onStall?: () => Promise<void>
}

export interface FoundCode {
    code: string
    receivedAt: Date
    subject: string
    mailbox: string
}

const IMAP_HOSTS: Record<string, string> = {
    'gmail.com': 'imap.gmail.com',
    'googlemail.com': 'imap.gmail.com',
    'outlook.com': 'outlook.office365.com',
    'hotmail.com': 'outlook.office365.com',
    'live.com': 'outlook.office365.com',
    'msn.com': 'outlook.office365.com',
    'yahoo.com': 'imap.mail.yahoo.com',
    'icloud.com': 'imap.mail.me.com',
    'me.com': 'imap.mail.me.com'
}

// Mail servers and the bot clock can disagree slightly; accept mails received this long before the request
const CLOCK_SKEW_MS = 45_000

// "Security code: 123456", "Your single-use code is 123456", "Code de sécurité : 123456", ...
const KEYWORD_CODE_REGEX =
    /(?:security\s*code|single-use\s*code|verification\s*code|one-time\s*code|your\s*code|code|c[oó]digo|sicherheitscode|kode|codice)\D{0,40}?(?<!\d)(\d{6})(?!\d)/gi
const BARE_CODE_REGEX = /(?<![\d#\-/.:])(\d{6})(?![\d\-/.:])/g

export function resolveImapHost(email: string): string | null {
    const domain = email.split('@')[1]?.toLowerCase()
    if (!domain) return null
    return IMAP_HOSTS[domain] ?? null
}

function isMicrosoftSender(address: string): boolean {
    const a = address.toLowerCase()
    return a.endsWith('microsoft.com') || a.endsWith('accountprotection.microsoft.com') || a.includes('@microsoft')
}

function htmlToText(html: string): string {
    return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>|<\/(p|div|tr|td|h\d|li)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/[ \t]+/g, ' ')
}

/**
 * Pulls the most likely 6-digit Microsoft code out of a mail body.
 * Prefers numbers right after a "code" keyword, otherwise the only distinct bare 6-digit number.
 */
export function extractCode(text: string): string | null {
    const keywordHits = [...text.matchAll(KEYWORD_CODE_REGEX)].map(m => m[1] as string)
    if (keywordHits.length) return keywordHits[0] as string

    const bare = [...new Set([...text.matchAll(BARE_CODE_REGEX)].map(m => m[1] as string))].filter(
        // Drop things that look like years/dates (e.g. 202610) rather than codes
        n => !/^(19|20)\d{2}(0[1-9]|1[0-2])$/.test(n)
    )
    return bare.length === 1 ? (bare[0] as string) : null
}

// "ex*****@gmail.com" vs "example@gmail.com" -> visible prefix/suffix must match
function matchesMaskedHint(text: string, hint: string): boolean {
    const h = hint.toLowerCase()
    const t = text.toLowerCase()
    if (!h.includes('*')) return t.includes(h)
    const [prefix, suffix] = h.split(/\*+/)
    const masked = t.match(/[a-z0-9._+-]*\*+[a-z0-9._-]*@[a-z0-9.-]+/g) ?? []
    if (masked.some(m => m === h)) return true
    return t.includes(prefix ?? '') && t.includes(suffix ?? '')
}

export class EmailCodeFetcher {
    private client: ImapFlow | null = null
    private mailboxes: string[] = []

    constructor(private readonly options: EmailCodeFetcherOptions) {}

    private log(level: 'info' | 'warn' | 'debug', message: string) {
        this.options.log?.(level, message)
    }

    async connect(): Promise<void> {
        if (this.client?.usable) return

        const host = this.options.host ?? resolveImapHost(this.options.user)
        if (!host) throw new Error(`No IMAP host known for ${this.options.user}; set emailCode.imapHost`)

        const passwords = [...new Set(this.options.passwords.filter(Boolean))]
        if (!passwords.length) throw new Error('No mailbox password configured')

        let lastError: unknown = null
        for (const [index, pass] of passwords.entries()) {
            const client = new ImapFlow({
                host,
                port: this.options.port ?? 993,
                secure: true,
                auth: { user: this.options.user, pass },
                logger: false,
                emitLogs: false
            })
            // Unhandled 'error' events would crash the process on socket drops
            client.on('error', err => this.log('debug', `IMAP socket error: ${err?.message ?? err}`))

            try {
                await client.connect()
                this.client = client
                this.log('info', `Connected to ${host} as ${this.options.user} (credential ${index + 1}/${passwords.length})`)
                this.mailboxes = await this.pickMailboxes(client)
                this.log('debug', `Searching mailboxes: ${this.mailboxes.join(', ')}`)
                return
            } catch (error) {
                lastError = error
                client.close()
                const detail = (error as { responseText?: string })?.responseText ?? getMessage(error)
                this.log('debug', `IMAP login failed with credential ${index + 1}: ${detail}`)
            }
        }

        const detail = (lastError as { responseText?: string })?.responseText ?? getMessage(lastError)
        const hint = /application-specific|app password|web login|AUTHENTICATIONFAILED|Invalid credentials/i.test(
            detail
        )
            ? ' (Gmail needs an App Password: enable 2-Step Verification, then create one at https://myaccount.google.com/apppasswords and put it in emailCode.appPassword)'
            : ''
        throw new Error(`IMAP login failed for ${this.options.user}: ${detail}${hint}`)
    }

    // Gmail: "All Mail" covers Primary/Promotions/Updates/labels; Spam is separate. Others: INBOX + Junk.
    private async pickMailboxes(client: ImapFlow): Promise<string[]> {
        const list: ListResponse[] = await client.list().catch(() => [])
        const bySpecial = (flag: string) => list.find(m => m.specialUse === flag)?.path
        const all = bySpecial('\\All')
        const junk = bySpecial('\\Junk') ?? list.find(m => /^(junk|spam|junk e-?mail|bulk)$/i.test(m.name))?.path

        const boxes = all ? [all] : ['INBOX']
        if (junk) boxes.push(junk)
        return boxes
    }

    async close(): Promise<void> {
        const client = this.client
        this.client = null
        if (client) await client.logout().catch(() => client.close())
    }

    /** One pass over all mailboxes; returns the newest matching code, if any. */
    async findLatestCode(notBefore: number, exclude: Set<string> = new Set()): Promise<FoundCode | null> {
        await this.connect()
        const client = this.client as ImapFlow
        const threshold = notBefore - CLOCK_SKEW_MS
        // IMAP SINCE is day-granular, so search from the day before and filter by exact received time below
        const since = new Date(threshold - 24 * 60 * 60 * 1000)

        const candidates: Array<FoundCode & { hintMatch: boolean }> = []

        for (const mailbox of this.mailboxes) {
            const lock = await client.getMailboxLock(mailbox).catch(() => null)
            if (!lock) continue
            try {
                const uids = (await client.search({ since, from: 'microsoft' }, { uid: true }).catch(() => [])) || []
                if (!uids.length) continue

                // Newest first; only look at the last handful
                const recent = uids.slice(-15).reverse()
                for await (const msg of client.fetch(
                    recent,
                    { uid: true, envelope: true, internalDate: true, source: true },
                    { uid: true }
                )) {
                    const receivedAt = msg.internalDate ? new Date(msg.internalDate) : null
                    if (!receivedAt || receivedAt.getTime() < threshold) continue

                    const from = msg.envelope?.from?.[0]?.address ?? ''
                    if (!isMicrosoftSender(from)) continue

                    const parsed = await simpleParser(msg.source as Buffer).catch(() => null)
                    if (!parsed) continue

                    const subject = parsed.subject ?? msg.envelope?.subject ?? ''
                    const body = `${subject}\n${parsed.text ?? ''}\n${parsed.html ? htmlToText(parsed.html) : ''}`
                    const code = extractCode(body)
                    if (!code || exclude.has(code)) continue

                    candidates.push({
                        code,
                        receivedAt,
                        subject,
                        mailbox,
                        hintMatch: this.options.targetHint ? matchesMaskedHint(body, this.options.targetHint) : true
                    })
                }
            } finally {
                lock.release()
            }
        }

        if (!candidates.length) return null

        // If any mail mentions the target account, ignore the others (several MS accounts may share one inbox)
        const pool = candidates.some(c => c.hintMatch) ? candidates.filter(c => c.hintMatch) : candidates
        pool.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
        const { hintMatch: _ignored, ...best } = pool[0]!
        return best
    }

    /** Polls the mailbox until a fresh code arrives or the timeout expires. */
    async waitForCode(options: WaitForCodeOptions): Promise<FoundCode | null> {
        const timeoutMs = options.timeoutMs ?? 180_000
        const pollIntervalMs = options.pollIntervalMs ?? 5_000
        const exclude = options.exclude ?? new Set<string>()
        const deadline = Date.now() + timeoutMs
        let stalled = false
        let polls = 0

        while (Date.now() < deadline) {
            polls++
            try {
                const found = await this.findLatestCode(options.notBefore, exclude)
                if (found) {
                    this.log(
                        'info',
                        `Code found in "${found.mailbox}" (received ${found.receivedAt.toISOString()}, subject "${found.subject}")`
                    )
                    return found
                }
            } catch (error) {
                // Drop the connection so the next poll reconnects; a bad password is not worth retrying
                await this.close()
                if (/IMAP login failed|No mailbox password|No IMAP host/.test(getMessage(error))) throw error
                this.log('warn', `Mailbox poll failed, retrying: ${getMessage(error)}`)
            }

            if (!stalled && options.onStall && Date.now() > deadline - timeoutMs / 2) {
                stalled = true
                await options.onStall().catch(() => {})
            }

            if (polls % 6 === 0) {
                this.log('info', `Still waiting for code email (${Math.round((deadline - Date.now()) / 1000)}s left)`)
            }
            await new Promise(r => setTimeout(r, pollIntervalMs))
        }

        return null
    }
}

function getMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
