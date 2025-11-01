import cluster from 'cluster'
import type { Page } from 'playwright'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtil from './browser/BrowserUtil'

import { log } from './util/Logger'
import Util from './util/Utils'
import { loadAccounts, loadConfig, saveSessionData } from './util/Load'
import { DISCORD } from './constants'

import { Login } from './functions/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'

import { Account } from './interface/Account'
import Axios from './util/Axios'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import Humanizer from './util/Humanizer'
import { detectBanReason } from './util/BanDetector'

// --- Small helpers used by this module ---
function shuffleArray<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = arr[i] as T
        arr[i] = arr[j] as T
        arr[j] = tmp
    }
    return arr
}

function randomInt(min: number, max: number) {
    if (min > max) [min, max] = [max, min]
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// --- end helpers ---

// Relay-aware logging: calls the original logger and also forwards worker logs to master via IPC
const originalLog = log
function rlog(isMobileFlag: any, tag: string, message: string, level?: 'log' | 'warn' | 'error', color?: string | undefined) {
    try {
        originalLog(isMobileFlag, tag, message, level, color as any)
    } catch (e) {
        try { console.log(`${tag}: ${message}`) } catch {}
    }
    // If this is a worker, forward the log to the master so all logs appear in the main terminal
    if (!cluster.isPrimary && typeof process.send === 'function') {
        try {
            process.send({
                __workerLog: true,
                payload: {
                    pid: process.pid,
                    timestamp: new Date().toISOString(),
                    isMobileFlag,
                    tag,
                    message,
                    level,
                    color
                }
            })
        } catch (e) {
            // ignore send errors
        }
    }
}

// Account summary interface for reporting
interface AccountSummary {
    email: string
    durationMs: number
    desktopCollected: number
    mobileCollected: number
    totalCollected: number
    initialTotal: number
    endTotal: number
    errors: string[]
    banned?: { status: boolean; reason: string }
}

// Main bot class
export class MicrosoftRewardsBot {
    public log: typeof rlog
    public config: any
    public utils: Util
    public activities: Activities = new Activities(this)
    public browser: {
        func: BrowserFunc,
        utils: BrowserUtil
    }
    public humanizer: Humanizer
    public isMobile: boolean
    public homePage!: Page
    public currentAccountEmail?: string
    public currentAccountRecoveryEmail?: string
    public compromisedModeActive: boolean = false
    public compromisedReason?: string
    public compromisedEmail?: string
    // Mutex-like flag to prevent parallel execution when config.parallel is accidentally misconfigured
    private isDesktopRunning: boolean = false
    private isMobileRunning: boolean = false

    private pointsCanCollect: number = 0
    private pointsInitial: number = 0

    private activeWorkers: number
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private workers: Workers
    private login = new Login(this)
    private accessToken: string = ''
    // Buy mode (manual spending) tracking
    private buyMode: { enabled: boolean; email?: string } = { enabled: false }

    // Summary collection (per process)
    private accountSummaries: AccountSummary[] = []
    private runId: string = Math.random().toString(36).slice(2)
    private diagCount: number = 0
    private bannedTriggered: { email: string; reason: string } | null = null
    private globalStandby: { active: boolean; reason?: string } = { active: false }
    // Scheduler heartbeat integration
    private heartbeatFile?: string
    private heartbeatTimer?: NodeJS.Timeout

    public axios!: Axios

    constructor(isMobile: boolean) {
        this.isMobile = isMobile
        this.log = rlog

        this.accounts = []
        this.utils = new Util()
        this.config = loadConfig()
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtil(this)
        }
        this.workers = new Workers(this)
        this.humanizer = new Humanizer(this.utils, this.config.humanization)
        this.activeWorkers = this.config.clusters

        // Base buy mode from config
        const cfgAny = this.config as unknown as { buyMode?: { enabled?: boolean } }
        if (cfgAny.buyMode?.enabled === true) {
            this.buyMode.enabled = true
        }
        // CLI: detect buy mode flag and target email (overrides config)
        const idx = process.argv.indexOf('-buy')
        if (idx >= 0) {
            const target = process.argv[idx + 1]
            if (target && /@/.test(target)) {
                this.buyMode = { enabled: true, email: target }
            } else {
                this.buyMode = { enabled: true }
            }
        }
    }

    public isBuyModeEnabled(): boolean {
        return this.buyMode.enabled === true
    }

    public getBuyModeTarget(): string | undefined {
        return this.buyMode.email
    }

    async initialize() {
        this.accounts = loadAccounts()
        // attach accounts to config so other parts can use them if needed
        ;(this.config as any).accounts = this.accounts
    }

    async run() {
        this.printBanner();
        rlog('main', 'MAIN', `Bot started with ${this.config.clusters} clusters`)

        // If scheduler provided a heartbeat file, update it periodically to signal liveness
        const hbFile = process.env.SCHEDULER_HEARTBEAT_FILE
        if (hbFile) {
            try {
                const dir = path.dirname(hbFile)
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
                fs.writeFileSync(hbFile, String(Date.now()))
                this.heartbeatFile = hbFile
                this.heartbeatTimer = setInterval(() => {
                    try { fs.writeFileSync(hbFile, String(Date.now())) } catch { /* ignore */ }
                }, 60_000)
            } catch { /* ignore */ }
        }

        // If buy mode is enabled, run single-account interactive session without automation
        if (this.buyMode.enabled) {
            const targetInfo = this.buyMode.email ? ` for ${this.buyMode.email}` : ''
            rlog('main', 'BUY-MODE', `Buy mode ENABLED${targetInfo}. We'll open 2 tabs: (1) a monitor tab that auto-refreshes to track points, (2) your browsing tab to redeem/purchase freely.`, 'log', 'green')
            rlog('main', 'BUY-MODE', 'The monitor tab may refresh every ~10s. Use the other tab for your actions; monitoring is passive and non-intrusive.', 'log', 'yellow')
            await this.runBuyMode()
            return
        }

        // Optionally shuffle accounts globally (configurable)
        const shouldShuffle = (this.config as any)?.shuffleAccounts ?? false
        if (shouldShuffle) {
            shuffleArray(this.accounts)
            rlog('main', 'MAIN', `Accounts shuffled (shuffleAccounts=true)`)
        }

        // If clusters <= 1 just run single-process logic
        if (this.config.clusters <= 1) {
            await this.runTasks(this.accounts)
            return
        }

        // Limit clusters to number of accounts so we don't spawn empty workers
        const requestedClusters = this.config.clusters
        const effectiveClusters = Math.max(1, Math.min(requestedClusters, this.accounts.length))
        if (effectiveClusters !== requestedClusters) {
            rlog('main', 'MAIN', `Adjusted clusters from ${requestedClusters} to ${effectiveClusters} to match account count`, 'warn')
            this.config.clusters = effectiveClusters
        }

        if (cluster.isPrimary) {
            this.runMasterWithStagger()
        } else {
            this.runWorker()
        }
    }

    private printBanner() {
        // Only print once (primary process or single cluster execution)
        if (this.config.clusters > 1 && !cluster.isPrimary) return
        const banner = `
 ███╗   ███╗███████╗    ██████╗ ███████╗██╗    ██╗ █████╗ ██████╗ ██████╗ ███████╗
 ████╗ ████║██╔════╝    ██╔══██╗██╔════╝██║    ██║██╔══██╗██╔══██╗██╔══██╗██╔════╝
 ██╔████╔██║███████╗    ██████╔╝█████╗  ██║ █╗ ██║███████║██████╔╝██║  ██║███████╗
 ██║╚██╔╝██║╚════██║    ██╔══██╗██╔══╝  ██║███╗██║██╔══██║██╔══██╗██║  ██║╚════██║
 ██║ ╚═╝ ██║███████║    ██║  ██║███████╗╚███╔███╔╝██║  ██║██║  ██║██████╔╝███████║
 ╚═╝     ╚═╝╚══════╝    ╚═╝  ╚═╝╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚══════╝
                      TypeScript • Playwright • Automated Point Collection
`
        const buyModeBanner = `
 ███╗   ███╗███████╗    ██████╗ ██╗   ██╗██╗   ██╗
 ████╗ ████║██╔════╝    ██╔══██╗██║   ██║╚██╗ ██╔╝
 ██╔████╔██║███████╗    ██████╔╝██║   ██║ ╚████╔╝
 ██║╚██╔╝██║╚════██║    ██╔══██╗██║   ██║  ╚██╔╝
 ██║ ╚═╝ ██║███████║    ██████╔╝╚██████╔╝   ██║
 ╚═╝     ╚═╝╚══════╝    ╚═════╝  ╚═════╝    ╚═╝
            By @Light • Manual Purchase Mode • Passive Monitoring
`
        try {
            const pkgPath = path.join(__dirname, '../', 'package.json')
            let version = 'unknown'
            if (fs.existsSync(pkgPath)) {
                const raw = fs.readFileSync(pkgPath, 'utf-8')
                const pkg = JSON.parse(raw)
                version = pkg.version || version
            }
            // Show appropriate banner based on mode
            const displayBanner = this.buyMode.enabled ? buyModeBanner : banner
            console.log(displayBanner)
            console.log('='.repeat(80))
            if (this.buyMode.enabled) {
                console.log(`  Version: ${version} | Process: ${process.pid} | Buy Mode: Active`)
                console.log(`  Target: ${this.buyMode.email || 'First account'} | Documentation: buy-mode.md`)
            } else {
                console.log(`  Version: ${version} | Process: ${process.pid} | Clusters: ${this.config.clusters}`)
                // Replace visibility/parallel with concise enabled feature status
                const upd = this.config.update || {}
                const updTargets: string[] = []
                if (upd.git !== false) updTargets.push('Git')
                if (upd.docker) updTargets.push('Docker')
                if (updTargets.length > 0) {
                    console.log(`  Update: ${updTargets.join(', ')}`)
                }
                const sched = this.config.schedule || {}
                const schedEnabled = !!sched.enabled
                if (!schedEnabled) {
                    console.log('  Schedule: OFF')
                } else {
                    // Determine active format + time string to display
                    const tz = sched.timeZone || 'UTC'
                    let formatName = ''
                    let timeShown = ''
                    const srec: Record<string, unknown> = sched as unknown as Record<string, unknown>
                    const useAmPmVal = typeof srec['useAmPm'] === 'boolean' ? (srec['useAmPm'] as boolean) : undefined
                    const time12Val = typeof srec['time12'] === 'string' ? String(srec['time12']) : undefined
                    const time24Val = typeof srec['time24'] === 'string' ? String(srec['time24']) : undefined
                    if (useAmPmVal === true) {
                        formatName = 'AM/PM'
                        timeShown = time12Val || sched.time || '9:00 AM'
                    } else if (useAmPmVal === false) {
                        formatName = '24h'
                        timeShown = time24Val || sched.time || '09:00'
                    } else {
                        // Back-compat: infer from provided fields if possible
                        if (time24Val && time24Val.trim()) { formatName = '24h'; timeShown = time24Val }
                        else if (time12Val && time12Val.trim()) { formatName = 'AM/PM'; timeShown = time12Val }
                        else { formatName = 'legacy'; timeShown = sched.time || '09:00' }
                    }
                    console.log(`  Schedule: ON — ${formatName} • ${timeShown} • TZ=${tz}`)
                }
            }
            console.log('='.repeat(80) + '\n')
        } catch {
            const displayBanner = this.buyMode.enabled ? buyModeBanner : banner
            console.log(displayBanner)
            console.log('='.repeat(50))
            if (this.buyMode.enabled) {
                console.log('  Microsoft Rewards Buy Mode Started')
                console.log('  See buy-mode.md for details')
            } else {
                console.log('  Microsoft Rewards Script Started')
            }
            console.log('='.repeat(50) + '\n')
        }
    }

    // Return summaries (used when clusters==1)
    public getSummaries() {
        return this.accountSummaries
    }

    /**
     * Manual spending session: login, then leave control to user while we passively monitor points.
     */
    private async runBuyMode() {
        try {
            await this.initialize()
            const email = this.buyMode.email || (this.accounts[0]?.email)
            const account = this.accounts.find(a => a.email === email) || this.accounts[0]
            if (!account) throw new Error('No account available for buy mode')
            this.isMobile = false
            this.axios = new Axios(account.proxy)
            const browser = await this.browserFactory.createBrowser(account.proxy, account.email)
            // Open the monitor tab FIRST so auto-refresh happens out of the way
            let monitor = await browser.newPage()
            await this.login.login(monitor, account.email, account.password, account.totp)
            await this.browser.func.goHome(monitor)
            this.log(false, 'BUY-MODE', 'Opened MONITOR tab (auto-refreshes to track points).', 'log', 'yellow')
            // Then open the user free-browsing tab SECOND so users don't see the refreshes
            const page = await browser.newPage()
            await this.browser.func.goHome(page)
            this.log(false, 'BUY-MODE', 'Opened USER tab (use this one to redeem/purchase freely).', 'log', 'green')
            // Helper to recreate monitor tab if the user closes it
            const recreateMonitor = async () => {
                try { if (!monitor.isClosed()) await monitor.close() } catch { /* ignore */ }
                monitor = await browser.newPage()
                await this.browser.func.goHome(monitor)
            }
            // Helper to send an immediate spend notice via webhooks/NTFY
            const sendSpendNotice = async (delta: number, nowPts: number, cumulativeSpent: number) => {
                try {
                    const { ConclusionWebhook } = await import('./util/ConclusionWebhook')
                    await ConclusionWebhook(
                        this.config,
                        '💳 Spend Detected',
                        `**Account:** ${account.email}\n**Spent:** -${delta} points\n**Current:** ${nowPts} points\n**Session spent:** ${cumulativeSpent} points`,
                        undefined,
                        0xFFAA00
                    )
                } catch (e) {
                    this.log(false, 'BUY-MODE', `Failed to send spend notice: ${e instanceof Error ? e.message : e}`, 'warn')
                }
            }
            let initial = 0
            try {
                const data = await this.browser.func.getDashboardData(monitor)
                initial = data.userStatus.availablePoints || 0
            } catch {/* ignore */}
            this.log(false, 'BUY-MODE', `Logged in as ${account.email}. Buy mode is active: monitor tab auto-refreshes; user tab is free for your actions. We'll observe points passively.`)
            // Passive watcher: poll points periodically without clicking.
            const start = Date.now()
            let last = initial
            let spent = 0
            const cfgAny = this.config as unknown as Record<string, unknown>
            const buyModeConfig = cfgAny['buyMode'] as Record<string, unknown> | undefined
            const maxMinutesRaw = buyModeConfig?.['maxMinutes'] ?? 45
            const maxMinutes = Math.max(10, Number(maxMinutesRaw))
            const endAt = start + maxMinutes * 60 * 1000
            while (Date.now() < endAt) {
                await this.utils.waitRandom(8000, 12000) // More human-like variable refresh interval ~8-12s
                // If monitor tab was closed by user, recreate it quietly
                try {
                    if (monitor.isClosed()) {
                        this.log(false, 'BUY-MODE', 'Monitor tab was closed; reopening in background...', 'warn')
                        await recreateMonitor()
                    }
                } catch { /* ignore */ }
                try {
                    const data = await this.browser.func.getDashboardData(monitor)
                    const nowPts = data.userStatus.availablePoints || 0
                    if (nowPts < last) {
                        // Points decreased -> likely spent
                        const delta = last - nowPts
                        spent += delta
                        last = nowPts
                        this.log(false, 'BUY-MODE', `Detected spend: -${delta} points (current: ${nowPts})`)
                        // Immediate spend notice
                        await sendSpendNotice(delta, nowPts, spent)
                    } else if (nowPts > last) {
                        last = nowPts
                    }
                } catch (err) {
                    // If we lost the page context, recreate the monitor tab and continue
                    const msg = err instanceof Error ? err.message : String(err)
                    if (/Target closed|page has been closed|browser has been closed/i.test(msg)) {
                        this.log(false, 'BUY-MODE', 'Monitor page closed or lost; recreating...', 'warn')
                        try { await recreateMonitor() } catch { /* ignore */ }
                    }
                    // Swallow other errors to avoid disrupting the user
                }
            }
            // Save cookies and close monitor; keep main page open for user until they close it themselves
            try {
                await saveSessionData(this.config.sessionPath, browser, account.email, this.isMobile)
            } catch (e) {
                this.log(false, 'BUY-MODE', `Failed to save session: ${e instanceof Error ? e.message : String(e)}`, 'warn')
            }
            try { if (!monitor.isClosed()) await monitor.close() } catch {/* ignore */}
            // Send a final minimal conclusion webhook for this manual session
            const summary: AccountSummary = {
                email: account.email,
                durationMs: Date.now() - start,
                desktopCollected: 0,
                mobileCollected: 0,
                totalCollected: -spent, // negative indicates spend
                initialTotal: initial,
                endTotal: last,
                errors: [],
                banned: { status: false, reason: '' }
            }
            await this.sendConclusion([summary])
            this.log(false, 'BUY-MODE', 'Buy mode session finished (monitoring period ended). You can close the browser when done.')
        } catch (e) {
            this.log(false, 'BUY-MODE', `Error in buy mode: ${e instanceof Error ? e.message : e}`, 'error')
        }
    }

    /**
     * Master: fork workers and provide each worker its own chunk of accounts plus an optional startDelay.
     * The first worker starts immediately, remaining workers will stagger their start between 30-60 minutes.
     * Also attaches message listeners to workers so forwarded logs are printed to the master terminal.
     */
    private runMasterWithStagger() {
        rlog(false, 'MAIN-PRIMARY', 'Primary process started')
        // Evenly chunk accounts into number of clusters
        const accountChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
        // set activeWorkers to the number of chunks we will create
        this.activeWorkers = accountChunks.length
        // constants for staggered start (30 - 60 minutes)
        const STAGGER_MIN_MS = 30 * 60 * 1000 // 30 minutes
        const STAGGER_MAX_MS = 60 * 60 * 1000 // 60 minutes
        for (let i = 0; i < accountChunks.length; i++) {
            const worker = cluster.fork()
            const chunk = accountChunks[i]!
            // Attach message listener immediately so we don't miss any forwarded logs
            worker.on('message', (msg: any) => {
                if (msg && msg.__workerLog && msg.payload) {
                    const p = msg.payload
                    const line = `[worker ${worker.process.pid}] ${p.timestamp} [${p.tag}] ${p.message}`
                    console.log(line)
                }
                // Handle account summary messages from workers
                if (msg && msg.type === 'summary' && Array.isArray(msg.data)) {
                    this.accountSummaries.push(...msg.data)
                }
            })
            // First worker starts immediately; others get a randomized delay
            const startDelay = (i === 0) ? 0 : randomInt(STAGGER_MIN_MS, STAGGER_MAX_MS)
            // Attach metadata so worker can log/know its place
            const message = {
                chunk,
                startDelay,
                workerIndex: i + 1,
                totalWorkers: accountChunks.length
            }
            // send the chunk and startDelay
            worker.send(message)
            rlog(false, 'MAIN-PRIMARY', `Forked worker ${worker.process.pid} assigned ${chunk.length} account(s) | startDelay=${startDelay}ms | worker ${i + 1}/${accountChunks.length}`)
        }
        // Listen for worker exits and track active count
        cluster.on('exit', (worker, code, signal) => {
            this.activeWorkers -= 1
            rlog(false, 'MAIN-WORKER', `Worker ${worker.process.pid} exited | Code: ${code} | Signal: ${signal} | Active workers remaining: ${this.activeWorkers}`, 'warn')
            // Optional: restart crashed worker (basic heuristic) if crashRecovery allows
            try {
                const cr = this.config.crashRecovery
                if (cr?.restartFailedWorker && code !== 0) {
                    const attempts = (worker as any)._restartAttempts || 0
                    if (attempts < (cr.restartFailedWorkerAttempts ?? 1) ) {
                        (worker as any)._restartAttempts = attempts + 1
                        rlog('main','CRASH-RECOVERY',`Respawning worker (attempt ${attempts + 1})`, 'warn','yellow')
                        const newW = cluster.fork()
                        newW.on('message', (msg: any) => {
                            if (msg && msg.type === 'summary' && Array.isArray(msg.data)) {
                                this.accountSummaries.push(...msg.data)
                            }
                        })
                    }
                }
            } catch { /* ignore */ }
            // Check if all workers have exited
            if (this.activeWorkers === 0) {
                // All workers done -> send conclusion (if enabled), run optional auto-update, then exit
                (async () => {
                    try {
                        await this.sendConclusion(this.accountSummaries)
                    } catch {/* ignore */}
                    try {
                        await this.runAutoUpdate()
                    } catch {/* ignore */}
                    // Only exit if not spawned by scheduler
                    if (!process.env.SCHEDULER_HEARTBEAT_FILE) {
                        rlog(false, 'MAIN-WORKER', 'All workers destroyed. Exiting main process!', 'warn')
                        process.exit(0)
                    } else {
                        rlog(false, 'MAIN-WORKER', 'All workers destroyed. Scheduler mode: returning control to scheduler.')
                    }
                })()
            }
        })
        // Graceful shutdown handling: relay to workers
        process.on('SIGINT', () => {
            rlog(false, 'MAIN-PRIMARY', 'SIGINT received. Asking workers to shut down gracefully...', 'warn')
            for (const id in cluster.workers) {
                cluster.workers[id]?.kill('SIGINT')
            }
        })
        // Catch unhandled errors in master to avoid silent death
        process.on('unhandledRejection', (reason) => {
            rlog(false, 'MAIN-PRIMARY', `Unhandled Rejection in master: ${reason}`, 'error')
        })
    }

    private runWorker() {
        rlog('main', 'MAIN-WORKER', `Worker ${process.pid} spawned`)
        // Receive the chunk of accounts (and optional startDelay) from the master
        process.on('message', async ({ chunk, startDelay, workerIndex, totalWorkers }: any) => {
            try {
                const idx = workerIndex ?? 0
                const total = totalWorkers ?? 0
                if (startDelay && startDelay > 0) {
                    rlog(this.isMobile, 'MAIN-WORKER', `Worker ${process.pid} (index ${idx}/${total}) will wait ${startDelay}ms before starting...`, 'log', 'yellow')
                    // Use utils.wait if available to be consistent with existing waits
                    if (this.utils && typeof (this.utils as any).wait === 'function') {
                        await (this.utils as any).wait(startDelay)
                    } else {
                        await sleep(startDelay)
                    }
                } else {
                    rlog(this.isMobile, 'MAIN-WORKER', `Worker ${process.pid} (index ${idx}/${total}) starting immediately...`)
                }
                await this.runTasks(chunk)
            } catch (err) {
                rlog(this.isMobile, 'MAIN-WORKER', `Worker ${process.pid} encountered an error: ${err}`, 'error')
                // ensure worker exits with non-zero so master can detect
                process.exit(1)
            }
        })
        // Extra graceful cleanup on worker
        process.on('SIGINT', () => {
            rlog(this.isMobile, 'MAIN-WORKER', `Worker ${process.pid} received SIGINT. Exiting...`, 'warn')
            process.exit(0)
        })
        process.on('unhandledRejection', (reason) => {
            rlog(this.isMobile, 'MAIN-WORKER', `Unhandled Rejection in worker: ${reason}`, 'error')
        })
    }

    /**
     * Runs tasks for the provided accounts array (sequentially).
     * Adds configurable random delays before starting each account and after finishing each account.
     * If an account fails login it will be marked with `doLater = true` (Login.handleFailedLogin)
     * and we will skip it during the first pass. After all accounts are processed we will perform
     * a single retry pass for those marked `doLater`.
     */
    private async runTasks(accounts: Account[]) {
        // read delay config and apply defaults
        const startMin = (this.config as any)?.accountStartDelayMinMs ?? 2000
        const startMax = (this.config as any)?.accountStartDelayMaxMs ?? 5000
        const finishMin = (this.config as any)?.accountFinishDelayMinMs ?? 1000
        const finishMax = (this.config as any)?.accountFinishDelayMaxMs ?? 3000
        // small optional per-account page delay to reduce flakiness
        const perAccountPageDelay = (this.config as any)?.perAccountPageDelayMs ?? 0

        for (const account of accounts) {
            // If a global standby is active due to security/banned, stop processing further accounts
            if (this.globalStandby.active) {
                rlog('main','SECURITY',`Global standby active (${this.globalStandby.reason || 'security-issue'}). Not proceeding to next accounts until resolved.`, 'warn', 'yellow')
                break
            }
            // Optional global stop after first ban
            if (this.config?.humanization?.stopOnBan === true && this.bannedTriggered) {
                rlog('main','TASK',`Stopping remaining accounts due to ban on ${this.bannedTriggered.email}: ${this.bannedTriggered.reason}`,'warn')
                break
            }
            // Reset compromised state per account
            this.compromisedModeActive = false
            this.compromisedReason = undefined
            this.compromisedEmail = undefined
            // If humanization allowed windows are configured, wait until within a window
            try {
                const windows: string[] | undefined = this.config?.humanization?.allowedWindows
                if (Array.isArray(windows) && windows.length > 0) {
                    const waitMs = this.computeWaitForAllowedWindow(windows)
                    if (waitMs > 0) {
                        rlog('main','HUMANIZATION',`Waiting ${Math.ceil(waitMs/1000)}s until next allowed window before starting ${account.email}`,'warn')
                        await new Promise<void>(r => setTimeout(r, waitMs))
                    }
                }
            } catch {/* ignore */}

            this.currentAccountEmail = account.email
            this.currentAccountRecoveryEmail = account.recoveryEmail
            rlog('main', 'MAIN-WORKER', `Preparing tasks for account ${account.email}`)
            // Reset compromised state per account
            this.compromisedModeActive = false
            this.compromisedReason = undefined
            this.compromisedEmail = undefined
            // Random pre-start delay
            const preDelay = randomInt(startMin, startMax)
            rlog('main', 'MAIN-WORKER', `Waiting ${preDelay}ms before starting account ${account.email}`)
            if (this.utils && typeof (this.utils as any).wait === 'function') {
                await (this.utils as any).wait(preDelay)
            } else {
                await sleep(preDelay)
            }
            this.axios = new Axios(account.proxy)
            const accountStart = Date.now()
            let desktopInitial = 0
            let mobileInitial = 0
            let desktopCollected = 0
            let mobileCollected = 0
            const errors: string[] = []
            const banned = { status: false, reason: '' }
            const verbose = process.env.DEBUG_REWARDS_VERBOSE === '1'
            const formatFullErr = (label: string, e: unknown) => {
                const base = shortErr(e)
                if (verbose && e instanceof Error) {
                    return `${label}:${base} :: ${e.stack?.split('\n').slice(0,4).join(' | ')}`
                }
                return `${label}:${base}`
            }

            try {
                if (this.config.parallel) {
                    // Run Desktop and Mobile in parallel but isolate failures so one side can't abort the other
                    const desktopPromise = (async () => {
                        try {
                            const desktopResult = await this.DesktopWithSmallDelay(account, perAccountPageDelay)
                            return desktopResult
                        } catch (err) {
                            rlog(this.isMobile, 'PARALLEL', `Desktop error for ${account.email}: ${err}`, 'error')
                            const bd = detectBanReason(err)
                            if (bd.status) {
                                banned.status = true; banned.reason = bd.reason.substring(0,200)
                                void this.handleImmediateBanAlert(account.email, banned.reason)
                            }
                            errors.push(formatFullErr('desktop', err))
                            return null
                        }
                    })()
                    const mobilePromise = (async () => {
                        try {
                            const mobileInstance = new MicrosoftRewardsBot(true)
                            // reuse axios/proxy for mobile instance
                            mobileInstance.axios = this.axios
                            // ensure config/accounts available
                            mobileInstance.config = this.config
                            mobileInstance.utils = this.utils
                            // initialize minimal things needed by Mobile (constructor did most)
                            const mobileResult = await mobileInstance.MobileWithSmallDelay(account, perAccountPageDelay)
                            return mobileResult
                        } catch (err) {
                            rlog(this.isMobile, 'PARALLEL', `Mobile error for ${account.email}: ${err}`, 'error')
                            const bd = detectBanReason(err)
                            if (bd.status) {
                                banned.status = true; banned.reason = bd.reason.substring(0,200)
                                void this.handleImmediateBanAlert(account.email, banned.reason)
                            }
                            errors.push(formatFullErr('mobile', err))
                            return null
                        }
                    })()
                    const settled = await Promise.allSettled([desktopPromise, mobilePromise])
                    // Log summary for visibility (but don't throw)
                    settled.forEach((res, idx) => {
                        if (res.status === 'fulfilled') {
                            const r = res.value
                            if (idx === 0 && r) {
                                desktopInitial = r.initialPoints || 0
                                desktopCollected = r.collectedPoints || 0
                            } else if (idx === 1 && r) {
                                mobileInitial = r.initialPoints || 0
                                mobileCollected = r.collectedPoints || 0
                            }
                        } else {
                            rlog(this.isMobile, 'PARALLEL', `Task ${idx === 0 ? 'Desktop' : 'Mobile'} rejected unexpectedly for ${account.email}: ${res.reason}`, 'warn')
                        }
                    })
                } else {
                    // Sequential execution with safety checks
                    if (this.isDesktopRunning || this.isMobileRunning) {
                        rlog('main', 'TASK', `Race condition detected: Desktop=${this.isDesktopRunning}, Mobile=${this.isMobileRunning}. Skipping to prevent conflicts.`, 'error')
                        errors.push('race-condition-detected')
                    } else {
                        // Sequential mode — run Desktop then Mobile, both wrapped individually
                        try {
                            this.isMobile = false
                            this.isDesktopRunning = true
                            const desktopResult = await this.DesktopWithSmallDelay(account, perAccountPageDelay)
                            if (desktopResult) {
                                desktopInitial = desktopResult.initialPoints
                                desktopCollected = desktopResult.collectedPoints
                            }
                        } catch (err) {
                            rlog(this.isMobile, 'SEQUENTIAL', `Desktop failed for ${account.email}: ${err}`, 'error')
                            const bd = detectBanReason(err)
                            if (bd.status) {
                                banned.status = true; banned.reason = bd.reason.substring(0,200)
                                void this.handleImmediateBanAlert(account.email, banned.reason)
                            }
                            errors.push(formatFullErr('desktop', err))
                        }
                        this.isDesktopRunning = false

                        // If banned or compromised detected, skip mobile to save time
                        if (!banned.status && !this.compromisedModeActive) {
                            try {
                                this.isMobile = true
                                this.isMobileRunning = true
                                const mobileResult = await this.MobileWithSmallDelay(account, perAccountPageDelay)
                                if (mobileResult) {
                                    mobileInitial = mobileResult.initialPoints
                                    mobileCollected = mobileResult.collectedPoints
                                }
                            } catch (err) {
                                rlog(this.isMobile, 'SEQUENTIAL', `Mobile failed for ${account.email}: ${err}`, 'error')
                                const bd = detectBanReason(err)
                                if (bd.status) {
                                    banned.status = true; banned.reason = bd.reason.substring(0,200)
                                    void this.handleImmediateBanAlert(account.email, banned.reason)
                                }
                                errors.push(formatFullErr('mobile', err))
                            }
                            this.isMobileRunning = false
                        } else {
                            const why = banned.status ? 'banned status' : 'compromised status'
                            rlog(this.isMobile, 'MAIN', `Skipping mobile flow for ${account.email} due to ${why}`, 'warn')
                        }
                    }
                }
                rlog('main', 'MAIN-WORKER', `Completed tasks for account ${account.email}`, 'log', 'green')
            } catch (err) {
                // This outer catch should rarely trigger now because inner tasks handle their own errors.
                rlog('main', 'MAIN-WORKER', `Error in tasks for ${account.email}: ${err}`, 'error')
                errors.push(formatFullErr('outer', err))
            }

            // Random post-finish delay
            const postDelay = randomInt(finishMin, finishMax)
            rlog('main', 'MAIN-WORKER', `Waiting ${postDelay}ms after finishing account ${account.email}`)
            if (this.utils && typeof (this.utils as any).wait === 'function') {
                await (this.utils as any).wait(postDelay)
            } else {
                await sleep(postDelay)
            }

            // Correct initial points (previous version double counted desktop+mobile baselines)
            // Strategy: pick the lowest non-zero baseline (desktopInitial or mobileInitial) as true start.
            // Sequential flow: desktopInitial < mobileInitial after gain -> min = original baseline.
            // Parallel flow: both baselines equal -> min is fine.
            const baselines: number[] = []
            if (desktopInitial) baselines.push(desktopInitial)
            if (mobileInitial) baselines.push(mobileInitial)
            let initialTotal = 0
            if (baselines.length === 1) initialTotal = baselines[0]!
            else if (baselines.length === 2) initialTotal = Math.min(baselines[0]!, baselines[1]!)
            // Fallback if both missing
            if (initialTotal === 0 && (desktopInitial || mobileInitial)) initialTotal = desktopInitial || mobileInitial || 0
            const totalCollected = desktopCollected + mobileCollected
            const endTotal = initialTotal + totalCollected
            const accountEnd = Date.now()
            const durationMs = accountEnd - accountStart

            this.accountSummaries.push({
                email: account.email,
                durationMs,
                desktopCollected,
                mobileCollected,
                totalCollected,
                initialTotal,
                endTotal,
                errors,
                banned
            })

            if (banned.status) {
                this.bannedTriggered = { email: account.email, reason: banned.reason }
                // Enter global standby: do not proceed to next accounts
                this.globalStandby = { active: true, reason: `banned:${banned.reason}` }
                await this.sendGlobalSecurityStandbyAlert(account.email, `Ban detected: ${banned.reason || 'unknown'}`)
            }
        }

        // After first pass, check for accounts marked `doLater` and perform a single retry pass.
        const failedAccounts = (accounts || []).filter(a => (a as any).doLater)
        if (failedAccounts.length > 0) {
            rlog('main', 'MAIN-RETRY', `Found ${failedAccounts.length} account(s) marked doLater. Performing a single retry pass...`, 'log', 'yellow')
            for (const acc of failedAccounts) {
                // Clear the flag before retry so handleFailedLogin can re-mark if it fails again
                (acc as any).doLater = false
                rlog('main', 'MAIN-RETRY', `Retrying account ${acc.email}`)
                try {
                    if (this.config.parallel) {
                        const desktopPromise = (async () => {
                            try {
                                return await this.DesktopWithSmallDelay(acc, perAccountPageDelay)
                            } catch (err) {
                                rlog(this.isMobile, 'RETRY', `Desktop retry error for ${acc.email}: ${err}`, 'warn')
                                return null
                            }
                        })()
                        const mobilePromise = (async () => {
                            try {
                                const mobileInstance = new MicrosoftRewardsBot(true)
                                mobileInstance.axios = this.axios
                                mobileInstance.config = this.config
                                mobileInstance.utils = this.utils
                                return await mobileInstance.MobileWithSmallDelay(acc, perAccountPageDelay)
                            } catch (err) {
                                rlog(this.isMobile, 'RETRY', `Mobile retry error for ${acc.email}: ${err}`, 'warn')
                                return null
                            }
                        })()
                        await Promise.allSettled([desktopPromise, mobilePromise])
                    } else {
                        try {
                            this.isMobile = false
                            await this.DesktopWithSmallDelay(acc, perAccountPageDelay)
                        } catch (err) {
                            rlog(this.isMobile, 'MAIN-RETRY', `Desktop retry failed for ${acc.email}: ${err}`, 'warn')
                        }
                        try {
                            this.isMobile = true
                            await this.MobileWithSmallDelay(acc, perAccountPageDelay)
                        } catch (err) {
                            rlog(this.isMobile, 'MAIN-RETRY', `Mobile retry failed for ${acc.email}: ${err}`, 'warn')
                        }
                    }
                } catch (err) {
                    rlog('main', 'MAIN-RETRY', `Retry failed for ${acc.email}: ${err}`, 'warn')
                }
            }
            const stillFailed = (accounts || []).filter(a => (a as any).doLater)
            if (stillFailed.length > 0) {
                rlog('main', 'MAIN-RETRY', `After retry, ${stillFailed.length} account(s) remain marked doLater. Please inspect them manually.`, 'error')
            } else {
                rlog('main', 'MAIN-RETRY', 'Retry pass succeeded for all previously failed accounts.', 'log', 'green')
            }
        }

        rlog(this.isMobile, 'MAIN-PRIMARY', 'Completed tasks for ALL accounts', 'log', 'green')

        // Extra diagnostic summary when verbose
        if (process.env.DEBUG_REWARDS_VERBOSE === '1') {
            for (const summary of this.accountSummaries) {
                rlog('main','SUMMARY-DEBUG',`Account ${summary.email} collected D:${summary.desktopCollected} M:${summary.mobileCollected} TOTAL:${summary.totalCollected} ERRORS:${summary.errors.length ? summary.errors.join(';') : 'none'}`)
            }
        }

        // If any account is flagged compromised, do NOT exit; keep the process alive so the browser stays open
        if (this.compromisedModeActive || this.globalStandby.active) {
            rlog('main','SECURITY','Compromised or banned detected. Global standby engaged: we will NOT proceed to other accounts until resolved. Keeping process alive. Press CTRL+C to exit when done. Security check by @Light','warn','yellow')
            // Periodic heartbeat with cleanup on exit
            const standbyInterval = setInterval(() => {
                rlog('main','SECURITY','Still in standby: session(s) held open for manual recovery / review...','warn','yellow')
            }, 5 * 60 * 1000)

            // Cleanup on process exit
            process.once('SIGINT', () => { clearInterval(standbyInterval); process.exit(0) })
            process.once('SIGTERM', () => { clearInterval(standbyInterval); process.exit(0) })
            return
        }

        // If in worker mode (clusters>1) send summaries to primary
        if (this.config.clusters > 1 && !cluster.isPrimary) {
            if (process.send) {
                process.send({ type: 'summary', data: this.accountSummaries })
            }
        } else {
            // Single process mode -> build and send conclusion directly
            await this.sendConclusion(this.accountSummaries)
            // Cleanup heartbeat timer/file at end of run
            if (this.heartbeatTimer) { try { clearInterval(this.heartbeatTimer) } catch { /* ignore */ } }
            if (this.heartbeatFile) { try { if (fs.existsSync(this.heartbeatFile)) fs.unlinkSync(this.heartbeatFile) } catch { /* ignore */ } }
            // After conclusion, run optional auto-update
            await this.runAutoUpdate().catch(() => {/* ignore update errors */})
        }
        // Only exit if not spawned by scheduler
        if (!process.env.SCHEDULER_HEARTBEAT_FILE) {
            process.exit()
        }
    }

    // wrapper to optionally add a small wait before/after Desktop run to reduce flakiness
    private async DesktopWithSmallDelay(account: Account, pageDelayMs: number) {
        if (pageDelayMs && pageDelayMs > 0) {
            await (this.utils && (this.utils as any).wait ? (this.utils as any).wait(pageDelayMs) : sleep(pageDelayMs))
        }
        const result = await this.Desktop(account)
        if (pageDelayMs && pageDelayMs > 0) {
            await (this.utils && (this.utils as any).wait ? (this.utils as any).wait(pageDelayMs) : sleep(pageDelayMs))
        }
        return result
    }

    private async MobileWithSmallDelay(account: Account, pageDelayMs: number): Promise<{ initialPoints: number; collectedPoints: number }> {
        if (pageDelayMs && pageDelayMs > 0) {
            await (this.utils && (this.utils as any).wait ? (this.utils as any).wait(pageDelayMs) : sleep(pageDelayMs))
        }
        const result = await this.Mobile(account)
        if (pageDelayMs && pageDelayMs > 0) {
            await (this.utils && (this.utils as any).wait ? (this.utils as any).wait(pageDelayMs) : sleep(pageDelayMs))
        }
        return result
    }

    // Desktop
    async Desktop(account: Account) {
        rlog(this.isMobile, 'FLOW', 'Desktop() invoked');
        const browser = await this.browserFactory.createBrowser(account.proxy, account.email);
        this.homePage = await browser.newPage();

        // Helper: small settle delay 1.0 - 1.5s
        const smallSettle = () => Math.floor(Math.random() * 500) + 1000;

        // randomInt helper
        const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

        // Utility helpers
        const randomDelay = async (minMs = 1000, maxMs = 3000) => {
            const delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
            if (this.utils && typeof this.utils.wait === 'function') {
                await this.utils.wait(delay);
            } else {
                await new Promise(res => setTimeout(res, delay));
            }
        };
        const humanScroll = async (page: Page) => {
            try {
                const viewportHeight = (page.viewportSize()?.height || 720) / 2;
                const scrollAmount = viewportHeight * (0.5 + Math.random() * 0.5);
                const direction = Math.random() > 0.5 ? 1 : -1;
                await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount * direction);
                await randomDelay(300, 700);
                if (Math.random() < 0.3) {
                    await page.evaluate((amount) => window.scrollBy(0, amount), -scrollAmount * direction * 0.2);
                    await randomDelay(100, 200);
                }
            } catch { /* ignore */ }
        };

        // Fast navigation + small waits (total ~1-1.5s)
        try {
            rlog(this.isMobile, 'MAIN', 'Navigating new desktop page to home (fast) to avoid waiting on blank tab');

            if (typeof this.browser.func.goHome === 'function') {
                await this.browser.func.goHome(this.homePage);
            } else {
                await this.homePage.goto('https://rewards.microsoft.com/', { waitUntil: 'domcontentloaded', timeout: 120000});
            }

            await this.homePage.waitForLoadState('domcontentloaded', { timeout: 100 }).catch(() => {});
            await this.homePage.waitForFunction(() => document.readyState === 'complete', { timeout: 100 }).catch(() => {});
            await this.homePage.waitForSelector('body', { timeout:200 }).catch(() => {});

            // Small settle delay (1.0-1.5s)
            const settleMs = smallSettle();
            this.log(this.isMobile, 'MAIN', `Page fast-loaded; waiting additional ${settleMs}ms for JS to settle.`);
            if (this.utils && typeof this.utils.wait === 'function') {
                await this.utils.wait(settleMs);
            } else {
                await new Promise(res => setTimeout(res, settleMs));
            }
        } catch (err) {
            rlog(this.isMobile, 'MAIN', `Fast page-ready wait failed: ${err}. Falling back to very short wait (1-1.5s).`, 'warn');
            const waitMs = 100 + Math.floor(Math.random() * 500);
            this.log(this.isMobile, 'MAIN', `Waiting ${waitMs}ms after creating new page (fallback).`);
            if (this.utils && typeof this.utils.wait === 'function') {
                await this.utils.wait(waitMs);
            } else {
                await new Promise(res => setTimeout(res, waitMs));
            }
        }

        rlog(this.isMobile, 'MAIN', 'Starting browser');
        // Login into MS Rewards, then go to rewards homepage
        await this.login.login(this.homePage, account.email, account.password, account.totp);

        if ((account as any).doLater) {
            rlog(this.isMobile, 'MAIN', `Login failed for ${account.email}. Skipping Desktop tasks and continuing.`, 'warn');
            await this.browser.func.closeBrowser(browser, account.email);
            return { initialPoints: 0, collectedPoints: 0 };
        }

        if (this.compromisedModeActive) {
            rlog(this.isMobile, 'SECURITY', `Account flagged as compromised (${this.compromisedReason || 'security-issue'}). Leaving the browser open and skipping all activities for ${account.email}.`, 'warn', 'yellow');
            try {
                await saveSessionData(this.config.sessionPath, browser, account.email, this.isMobile);
            } catch (e) {
                rlog(this.isMobile, 'SECURITY', `Failed to save session: ${e instanceof Error ? e.message : String(e)}`, 'warn')
            }
            return { initialPoints: 0, collectedPoints: 0 };
        }

        await this.browser.func.goHome(this.homePage);
        await humanScroll(this.homePage);
        await randomDelay(500, 1500);
        let data = await this.browser.func.getDashboardData();
        this.pointsInitial = data.userStatus.availablePoints;
        const initial = this.pointsInitial;
        rlog(this.isMobile, 'MAIN-POINTS', `Current point count: ${this.pointsInitial}`);

        const browserEnarablePoints = await this.browser.func.getBrowserEarnablePoints();
        this.pointsCanCollect = browserEnarablePoints.dailySetPoints +
            browserEnarablePoints.desktopSearchPoints +
            browserEnarablePoints.morePromotionsPoints;
        rlog(this.isMobile, 'MAIN-POINTS', `You can earn ${this.pointsCanCollect} points today`);

        if (this.pointsCanCollect === 0) {
            // Extra diagnostic breakdown so users know WHY it's zero
            rlog(this.isMobile, 'MAIN-POINTS', `Breakdown (desktop): dailySet=${browserEnarablePoints.dailySetPoints} search=${browserEnarablePoints.desktopSearchPoints} promotions=${browserEnarablePoints.morePromotionsPoints}`)
            rlog(this.isMobile, 'MAIN-POINTS', 'All desktop earnable buckets are zero. This usually means: tasks already completed today OR the daily reset has not happened yet for your time zone. If you still want to force run activities set execution.runOnZeroPoints=true in config.', 'log', 'yellow')
        }

        if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0) {
            rlog(this.isMobile, 'MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping!', 'log', 'yellow');
            await this.browser.func.closeBrowser(browser, account.email);
            return { initialPoints: initial, collectedPoints: 0 };
        }

        // Create worker page for activities
        const workerPage = await browser.newPage();
        await this.browser.func.goHome(workerPage);

        // Interleaving loop for human-like task switching
        const maxLoops = 100; // Safety to prevent infinite loops
        let loopCount = 0;
        let currentData = data;

        // Track progress for activities that need multiple steps
        const activityProgress = {
            dailySetCompleted: new Set<string>(),
            punchCardsCompleted: new Set<string>(),
            morePromotionsCompleted: new Set<string>()
        };

        while (loopCount < maxLoops) {
            loopCount++;
            await this.browser.func.goHome(this.homePage);
            currentData = await this.browser.func.getDashboardData(); // Refresh data to check pending tasks

            const categories: { name: string; action: () => Promise<void>; priority: number }[] = [];

            // Daily Set - process 1-2 activities at a time
            const today = this.utils.getFormattedDate();
            const dailyUncompleted = (currentData.dailySetPromotions[today] ?? [])
                .filter(x => !x.complete && x.pointProgressMax > 0)
                .filter(x => !activityProgress.dailySetCompleted.has(x.offerId || x.title));

            if (this.config.workers.doDailySet && dailyUncompleted.length > 0) {
                categories.push({
                    name: 'daily',
                    action: async () => {
                        const activitiesToProcess = dailyUncompleted.slice(0, randomInt(1, 2)); // Process 1-2 activities
                        this.log(this.isMobile, 'INTERLEAVE', `Processing ${activitiesToProcess.length} Daily Set activities`);

                        await this.workers.doDailySet(workerPage, currentData, activitiesToProcess.length);

                        // Mark as completed in our progress tracker
                        activitiesToProcess.forEach(activity => {
                            activityProgress.dailySetCompleted.add(activity.offerId || activity.title);
                        });
                    },
                    priority: 3 // High priority - daily sets are time-sensitive
                });
            }

            // Punch Cards - process 1 card at a time
            // FIXED: Add proper type guard for parentPromotion
            const punchUncompleted = (currentData.punchCards ?? [])
                .filter(x => x.parentPromotion && !x.parentPromotion.complete)
                .filter(x => {
                    // Type guard to ensure parentPromotion exists
                    if (!x.parentPromotion) return false;
                    return !activityProgress.punchCardsCompleted.has(x.parentPromotion.title);
                });

            if (this.config.workers.doPunchCards && punchUncompleted.length > 0) {
                categories.push({
                    name: 'punch',
                    action: async () => {
                        const cardsToProcess = punchUncompleted.slice(0, 1); // Process 1 punch card
                        // FIXED: Add null check for parentPromotion
                        if (cardsToProcess.length > 0 && cardsToProcess[0]?.parentPromotion) {
                            this.log(this.isMobile, 'INTERLEAVE', `Processing 1 Punch Card: ${cardsToProcess[0].parentPromotion.title}`);

                            await this.workers.doPunchCard(workerPage, currentData, 1);

                            // Mark as completed in our progress tracker
                            cardsToProcess.forEach(card => {
                                if (card.parentPromotion) {
                                    activityProgress.punchCardsCompleted.add(card.parentPromotion.title);
                                }
                            });
                        }
                    },
                    priority: 2 // Medium priority
                });
            }

            // More Promotions - process 1-2 activities at a time
            const moreUncompleted = (currentData.morePromotions ?? [])
                .filter(x => !x.complete && x.pointProgressMax > 0 && x.exclusiveLockedFeatureStatus !== 'locked')
                .filter(x => !activityProgress.morePromotionsCompleted.has(x.offerId || x.title));

            if (this.config.workers.doMorePromotions && moreUncompleted.length > 0) {
                categories.push({
                    name: 'promotions',
                    action: async () => {
                        const activitiesToProcess = moreUncompleted.slice(0, randomInt(1, 2)); // Process 1-2 activities
                        this.log(this.isMobile, 'INTERLEAVE', `Processing ${activitiesToProcess.length} More Promotion activities`);

                        await this.workers.doMorePromotions(workerPage, currentData, activitiesToProcess.length);

                        // Mark as completed in our progress tracker
                        activitiesToProcess.forEach(activity => {
                            activityProgress.morePromotionsCompleted.add(activity.offerId || activity.title);
                        });
                    },
                    priority: 1 // Lower priority
                });
            }

            // Desktop Search (chunked) - process 2-4 searches at a time
            const pcSearchData = await this.browser.func.getSearchPoints();
            const pcSearch = pcSearchData.pcSearch ? pcSearchData.pcSearch[0] : null;
            if (this.config.workers.doDesktopSearch && pcSearch && pcSearch.pointProgress < pcSearch.pointProgressMax) {
                categories.push({
                    name: 'search',
                    action: async () => {
                        const pointsPerSearch = (this.config.searchSettings?.pointsPerSearch) || 5;
                        const missingPoints = Math.max(0, (pcSearch.pointProgressMax || 0) - (pcSearch.pointProgress || 0));
                        const needed = Math.max(1, Math.ceil(missingPoints / pointsPerSearch));

                        // Do 2-4 searches per iteration
                        const searchesToDo = randomInt(2, 4);
                        const actualSearches = Math.min(searchesToDo, needed);

                        this.log(this.isMobile, 'SEARCH-INTERLEAVE', `Desktop: performing ${actualSearches} searches (${missingPoints} points remaining, ${needed} total needed)`);
                        try {
                            await this.activities.doSearch(workerPage, currentData, actualSearches);
                        } catch (err) {
                            this.log(this.isMobile, 'INTERLEAVE', `Desktop search action failed: ${err}`, 'warn');
                        }
                    },
                    priority: 2 // Medium priority - searches are important but can be interleaved
                });
            }

            if (categories.length === 0) {
                this.log(this.isMobile, 'INTERLEAVE', 'All tasks completed!', 'log', 'green');
                break; // All done
            }

            // Sort by priority (higher first) and pick from top 2-3 categories
            categories.sort((a, b) => b.priority - a.priority);
            const topCategories = categories.slice(0, randomInt(2, 3));
            const picked = topCategories[randomInt(0, topCategories.length - 1)];

            if (picked) {
                try {
                    this.log(this.isMobile, 'INTERLEAVE', `Executing ${picked.name} task (priority: ${picked.priority})`);
                    await picked.action();
                } catch (err) {
                    this.log(this.isMobile, 'INTERLEAVE', `Error in category ${picked.name}: ${err}`, 'warn');
                    // Continue to next without stopping
                }
            }

            // Variable pause between loop iterations (3-10 seconds)
            await randomDelay(3000, 10000);

            // Occasionally refresh data to get current state
            if (loopCount % 5 === 0) {
                try {
                    currentData = await this.browser.func.getDashboardData();
                } catch (err) {
                    this.log(this.isMobile, 'INTERLEAVE', `Failed to refresh dashboard data: ${err}`, 'warn');
                }
            }
        }

        if (loopCount >= maxLoops) {
            this.log(this.isMobile, 'INTERLEAVE', 'Max loop count reached; possible stuck tasks. Proceeding to close.', 'warn');
        }

        await saveSessionData(this.config.sessionPath, browser, account.email, this.isMobile);
        const after = await this.browser.func.getCurrentPoints().catch(() => initial);
        await this.browser.func.closeBrowser(browser, account.email);

        this.log(this.isMobile, 'DESKTOP-SUMMARY', `Completed Desktop session: ${initial} → ${after} points (+${after - initial})`);
        return {
            initialPoints: initial,
            collectedPoints: (after - initial) || 0
        };
    }

    // Mobile
    async Mobile(account: Account): Promise<{ initialPoints: number; collectedPoints: number }> {
        rlog(this.isMobile, 'FLOW', 'Mobile() invoked');
        let browser = await this.browserFactory.createBrowser(account.proxy, account.email);
        this.homePage = await browser.newPage();

        // Helper small settle
        const smallSettle = () => Math.floor(Math.random() * 500) + 1000;

        // randomInt helper
        const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

        // Utility helpers (same as Desktop)
        const randomDelay = async (minMs = 1000, maxMs = 3000) => {
            const delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
            if (this.utils && typeof this.utils.wait === 'function') {
                await this.utils.wait(delay);
            } else {
                await new Promise(res => setTimeout(res, delay));
            }
        };
        const humanScroll = async (page: Page) => {
            try {
                const viewportHeight = (page.viewportSize()?.height || 720) / 2;
                const scrollAmount = viewportHeight * (0.5 + Math.random() * 0.5);
                const direction = Math.random() > 0.5 ? 1 : -1;
                await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount * direction);
                await randomDelay(300, 700);
                if (Math.random() < 0.3) {
                    await page.evaluate((amount) => window.scrollBy(0, amount), -scrollAmount * direction * 0.2);
                    await randomDelay(100, 200);
                }
            } catch { /* ignore */ }
        };

        // Fast initial navigation & small waits
        try {
            rlog(this.isMobile, 'MAIN', 'Navigating new mobile page to home (fast) to avoid waiting on blank tab');
            if (typeof this.browser.func.goHome === 'function') {
                await this.browser.func.goHome(this.homePage);
            } else {
                await this.homePage.goto('https://rewards.microsoft.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });
            }
            await this.homePage.waitForLoadState('domcontentloaded', { timeout: 5000 + Math.random() * 2000 }).catch(() => { })
            await this.homePage.waitForFunction(() => document.readyState === 'complete', { timeout: 1500 + Math.random() * 1000 }).catch(() => {})
            await this.homePage.waitForSelector('body', { timeout: 5000 + Math.random() * 2000 }).catch(() => { })
            const settleMs = smallSettle();
            this.log(this.isMobile, 'MAIN', `Page fast-loaded; waiting additional ${settleMs}ms for JS to settle.`);
            if (this.utils && typeof this.utils.wait === 'function') {
                await this.utils.wait(settleMs);
            } else {
                await new Promise(res => setTimeout(res, settleMs));
            }
        } catch (err) {
            rlog(this.isMobile, 'MAIN', `Fast page-ready wait failed: ${err}. Falling back to very short wait (1-1.5s).`, 'warn');
            const waitMs = Math.floor(Math.random() * 500);
            this.log(this.isMobile, 'MAIN', `Waiting ${waitMs}ms after creating new page (fallback).`);
            if (this.utils && typeof this.utils.wait === 'function') {
                await this.utils.wait(waitMs);
            } else {
                await new Promise(res => setTimeout(res, waitMs));
            }
        }

        rlog(this.isMobile, 'MAIN', 'Starting browser (mobile)');

        await this.login.login(this.homePage, account.email, account.password, account.totp);
        if ((account as any).doLater) {
            rlog(this.isMobile, 'MAIN', `Login failed for ${account.email}. Skipping Mobile tasks and continuing.`, 'warn');
            await this.browser.func.closeBrowser(browser, account.email);
            return { initialPoints: 0, collectedPoints: 0 };
        }

        if (this.compromisedModeActive) {
            rlog(this.isMobile, 'SECURITY', `Account flagged as compromised (${this.compromisedReason || 'security-issue'}). Leaving mobile browser open and skipping mobile activities for ${account.email}.`, 'warn', 'yellow');
            try {
                await saveSessionData(this.config.sessionPath, browser, account.email, this.isMobile);
            } catch (e) {
                rlog(this.isMobile, 'SECURITY', `Failed to save session: ${e instanceof Error ? e.message : String(e)}`, 'warn')
            }
            return { initialPoints: 0, collectedPoints: 0 };
        }

        this.accessToken = (await this.login.getMobileAccessToken(this.homePage, account.email)) ?? '';

        if (!this.accessToken || this.accessToken === '') {
            rlog(this.isMobile, 'MAIN', `Mobile access token missing for ${account.email}. Will retry after short wait.`, 'warn');

            // Close current browser before waiting
            try { await this.browser.func.closeBrowser(browser, account.email); } catch (err) { rlog(this.isMobile, 'MAIN', `Error closing browser before retry for ${account.email}: ${err}`, 'warn'); }

            // Wait only 1-1.5s (instead of 10 minutes)
            const TEN_MS = Math.floor(Math.random() * 500) + 1000;
            if (this.utils && typeof this.utils.wait === 'function') {
                await this.utils.wait(TEN_MS);
            } else {
                await new Promise(res => setTimeout(res, TEN_MS));
            }

            // Recreate browser and retry login once
            rlog(this.isMobile, 'MAIN', `Retrying mobile login for ${account.email} now...`, 'log', 'yellow');
            try {
                browser = await this.browserFactory.createBrowser(account.proxy, account.email);
                this.homePage = await browser.newPage();

                // Try fast load again
                try {
                    if (typeof this.browser.func.goHome === 'function') {
                        await this.browser.func.goHome(this.homePage);
                    } else {
                        await this.homePage.goto('https://rewards.microsoft.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });
                    }
                    await this.homePage.waitForLoadState('domcontentloaded', { timeout: 5000 + Math.random() * 2000 }).catch(() => { })
                    await this.homePage.waitForFunction(() => document.readyState === 'complete', { timeout: 1500 + Math.random() * 1000 }).catch(() => {})
                    await this.homePage.waitForSelector('body', { timeout: 5000 + Math.random() * 2000 }).catch(() => { })
                    const settleMs = smallSettle();
                    if (this.utils && typeof this.utils.wait === 'function') {
                        await this.utils.wait(settleMs);
                    } else {
                        await new Promise(res => setTimeout(res, settleMs));
                    }
                } catch (err) {
                    rlog(this.isMobile, 'MAIN', `Retry page-ready fast wait failed: ${err}. Continuing anyway.`, 'warn');
                }

                await this.login.login(this.homePage, account.email, account.password, account.totp);
                if ((account as any).doLater) {
                    rlog(this.isMobile, 'MAIN', `Retry login failed for ${account.email}. Marking doLater and skipping Mobile tasks.`, 'warn');
                    await this.browser.func.closeBrowser(browser, account.email);
                    return { initialPoints: 0, collectedPoints: 0 };
                }

                this.accessToken = (await this.login.getMobileAccessToken(this.homePage, account.email)) ?? '';
                if (!this.accessToken || this.accessToken === '') {
                    rlog(this.isMobile, 'MAIN', `Retry did not produce a mobile access token for ${account.email}. Marking doLater and skipping Mobile tasks.`, 'error');
                    (account as any).doLater = true;
                    await this.browser.func.closeBrowser(browser, account.email);
                    return { initialPoints: 0, collectedPoints: 0 };
                }
                rlog(this.isMobile, 'MAIN', `Retry succeeded, obtained mobile access token for ${account.email}`, 'log', 'green');
            } catch (err) {
                rlog(this.isMobile, 'MAIN', `Error during mobile retry for ${account.email}: ${err}`, 'error');
                (account as any).doLater = true;
                try { await this.browser.func.closeBrowser(browser, account.email); } catch {}
                return { initialPoints: 0, collectedPoints: 0 };
            }
        }

        // Continue normal mobile flow
        await this.browser.func.goHome(this.homePage);
        await humanScroll(this.homePage);
        await randomDelay(500, 1500);
        const data = await this.browser.func.getDashboardData();
        const initialPoints = data.userStatus.availablePoints || this.pointsInitial || 0;
        const browserEnarablePoints = await this.browser.func.getBrowserEarnablePoints();
        const appEarnablePoints = await this.browser.func.getAppEarnablePoints(this.accessToken);

        const browserMobilePoints = browserEnarablePoints.mobileSearchPoints ?? 0;
        let totalAppPoints = 0;
        let appFetchFailed = false;
        if (appEarnablePoints && appEarnablePoints.fetchError) {
            appFetchFailed = true;
            this.log(this.isMobile, 'MAIN', 'App earnable points fetch failed; proceeding using browser points only.');
        } else {
            totalAppPoints = appEarnablePoints?.totalEarnablePoints ?? 0;
        }

        this.pointsCanCollect = browserMobilePoints + totalAppPoints;
        rlog(this.isMobile, 'MAIN-POINTS', `You can earn ${this.pointsCanCollect} points today (Browser: ${browserMobilePoints} points, App: ${appFetchFailed ? 'unknown (fetch failed)' : totalAppPoints + ' points'})`);

        if (this.pointsCanCollect === 0) {
            rlog(this.isMobile, 'MAIN-POINTS', `Breakdown (mobile): browserSearch=${browserMobilePoints} appTotal=${appEarnablePoints?.totalEarnablePoints}`)
            rlog(this.isMobile, 'MAIN-POINTS', 'All mobile earnable buckets are zero. Causes: mobile searches already maxed, daily set finished, or daily rollover not reached yet. You can force execution by setting execution.runOnZeroPoints=true.', 'log', 'yellow')
        }

        if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0 && !appFetchFailed) {
            rlog(this.isMobile, 'MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping!', 'log', 'yellow');
            await this.browser.func.closeBrowser(browser, account.email);
            return { initialPoints: initialPoints, collectedPoints: 0 };
        } else if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0 && appFetchFailed) {
            rlog(this.isMobile, 'MAIN', 'App points unknown due to fetch error but proceeding because app data is unavailable.', 'log', 'yellow');
        }

        // Create worker page for mobile searches
        const workerPage = await browser.newPage();
        await this.browser.func.goHome(workerPage);

        // Interleaving loop for mobile
        const maxLoops = 100;
        let loopCount = 0;
        let currentData = data;

        // Flags for single-run tasks like checkin and read
        let checkInDone = false;
        let readDone = false;

        while (loopCount < maxLoops) {
            loopCount++;
            await this.browser.func.goHome(this.homePage);
            currentData = await this.browser.func.getDashboardData(); // refresh

            const categories: { name: string; action: () => Promise<void>; priority: number }[] = [];

            // Daily Check-in (one-time)
            if (this.config.workers.doDailyCheckIn && !checkInDone) {
                categories.push({
                    name: 'checkin',
                    action: async () => {
                        this.log(this.isMobile, 'INTERLEAVE', 'Performing daily check-in');
                        await this.activities.doDailyCheckIn(this.accessToken, currentData);
                        checkInDone = true;
                    },
                    priority: 3 // High priority - one-time task
                });
            }

            // Mobile Search (chunked) - process 2-4 searches at a time
            const mobileSearchData = await this.browser.func.getSearchPoints();
            const mobileSearchCounter = mobileSearchData.mobileSearch ? mobileSearchData.mobileSearch[0] : null;
            const searchesRemain = mobileSearchCounter ? (mobileSearchCounter.pointProgress < mobileSearchCounter.pointProgressMax) : false;

            if (this.config.workers.doMobileSearch && mobileSearchCounter && mobileSearchCounter.pointProgress < mobileSearchCounter.pointProgressMax) {
                categories.push({
                    name: 'search',
                    action: async () => {
                        const pointsPerSearch = (this.config.searchSettings?.pointsPerSearch) || 5;
                        const missingPoints = Math.max(0, (mobileSearchCounter.pointProgressMax || 0) - (mobileSearchCounter.pointProgress || 0));
                        const needed = Math.max(1, Math.ceil(missingPoints / pointsPerSearch));

                        // Do 2-4 searches per iteration
                        const searchesToDo = randomInt(2, 4);
                        const actualSearches = Math.min(searchesToDo, needed);

                        this.log(this.isMobile, 'SEARCH-INTERLEAVE', `Mobile: performing ${actualSearches} searches (${missingPoints} points remaining, ${needed} total needed)`);
                        try {
                            await this.activities.doSearch(workerPage, currentData, actualSearches);
                        } catch (err) {
                            this.log(this.isMobile, 'INTERLEAVE', `Mobile search action failed: ${err}`, 'warn');
                        }
                    },
                    priority: 1 // Lower priority - can be interleaved with other tasks
                });
            }

            // Read to Earn (one-time) -- PUSH ONLY AFTER ALL MOBILE SEARCHES ARE DONE
            // If searchesRemain is true we skip adding read (so read will be deferred).
            // If there are no mobile searches or they are finished, add read (low priority so it runs last).
            if (this.config.workers.doReadToEarn && !readDone && !searchesRemain) {
                categories.push({
                    name: 'read',
                    action: async () => {
                        this.log(this.isMobile, 'INTERLEAVE', 'Performing read to earn');
                        await this.activities.doReadToEarn(this.accessToken, currentData);
                        readDone = true;
                    },
                    priority: 0 // Lowest priority — ensure it runs after searches/checkins
                });
            }

            if (categories.length === 0) {
                this.log(this.isMobile, 'INTERLEAVE', 'All mobile tasks completed!', 'log', 'green');
                break;
            }

            // Sort by priority and pick from top categories
            categories.sort((a, b) => b.priority - a.priority);
            const topCategories = categories.slice(0, randomInt(1, 2)); // Mobile: be more focused
            const picked = topCategories[randomInt(0, topCategories.length - 1)];

            if (picked) {
                try {
                    this.log(this.isMobile, 'INTERLEAVE', `Executing mobile ${picked.name} task`);
                    await picked.action();
                } catch (err) {
                    this.log(this.isMobile, 'INTERLEAVE', `Error in mobile category ${picked.name}: ${err}`, 'warn');
                }
            }

            // Shorter pauses for mobile (2-8 seconds)
            await randomDelay(2000, 8000);

            // Refresh data periodically
            if (loopCount % 5 === 0) {
                try {
                    currentData = await this.browser.func.getDashboardData();
                } catch (err) {
                    this.log(this.isMobile, 'INTERLEAVE', `Failed to refresh mobile dashboard data: ${err}`, 'warn');
                }
            }
        }

        if (loopCount >= maxLoops) {
            this.log(this.isMobile, 'INTERLEAVE', 'Max mobile loop count reached; proceeding to close.', 'warn');
        }

        const afterPointAmount = await this.browser.func.getCurrentPoints();
        rlog(this.isMobile, 'MAIN-POINTS', `Mobile session collected ${afterPointAmount - initialPoints} points today`);
        await this.browser.func.closeBrowser(browser, account.email);

        this.log(this.isMobile, 'MOBILE-SUMMARY', `Completed Mobile session: ${initialPoints} → ${afterPointAmount} points (+${afterPointAmount - initialPoints})`);
        return {
            initialPoints: initialPoints,
            collectedPoints: (afterPointAmount - initialPoints) || 0
        };
    }


    /** Compute milliseconds to wait until within one of the allowed windows (HH:mm-HH:mm). Returns 0 if already inside. */
    private computeWaitForAllowedWindow(windows: string[]): number {
        const now = new Date()
        const minsNow = now.getHours() * 60 + now.getMinutes()
        let nextStartMins: number | null = null
        for (const w of windows) {
            const [start, end] = w.split('-')
            if (!start || !end) continue
            const pStart = start.split(':').map(v=>parseInt(v,10))
            const pEnd = end.split(':').map(v=>parseInt(v,10))
            if (pStart.length !== 2 || pEnd.length !== 2) continue
            const sh = pStart[0]!, sm = pStart[1]!
            const eh = pEnd[0]!, em = pEnd[1]!
            if ([sh,sm,eh,em].some(n=>Number.isNaN(n))) continue
            const s = sh*60 + sm
            const e = eh*60 + em
            if (s <= e) {
                // same-day window
                if (minsNow >= s && minsNow <= e) return 0
                if (minsNow < s) nextStartMins = Math.min(nextStartMins ?? s, s)
            } else {
                // wraps past midnight (e.g., 22:00-02:00)
                if (minsNow >= s || minsNow <= e) return 0
                // next start today is s
                nextStartMins = Math.min(nextStartMins ?? s, s)
            }
        }
        const msPerMin = 60*1000
        if (nextStartMins != null) {
            const targetTodayMs = (nextStartMins - minsNow) * msPerMin
            return targetTodayMs > 0 ? targetTodayMs : (24*60 + nextStartMins - minsNow) * msPerMin
        }
        // No valid windows parsed -> do not block
        return 0
    }

    /** Send immediate ban alert if configured. */
    private async handleImmediateBanAlert(email: string, reason: string): Promise<void> {
        try {
            const h = this.config?.humanization
            if (!h || h.immediateBanAlert === false) return
            const { ConclusionWebhook } = await import('./util/ConclusionWebhook')
            await ConclusionWebhook(
                this.config,
                '🚫 Ban Detected',
                `**Account:** ${email}\n**Reason:** ${reason || 'detected by heuristics'}`,
                undefined,
                DISCORD.COLOR_RED
            )
        } catch (e) {
            rlog('main','ALERT',`Failed to send ban alert: ${e instanceof Error ? e.message : e}`,'warn')
        }
    }

    /** Public entry-point to engage global security standby from other modules (idempotent). */
    public async engageGlobalStandby(reason: string, email?: string): Promise<void> {
        try {
            if (this.globalStandby.active) return
            this.globalStandby = { active: true, reason }
            const who = email || this.currentAccountEmail || 'unknown'
            await this.sendGlobalSecurityStandbyAlert(who, reason)
        } catch {/* ignore */}
    }

    /** Send a strong alert to all channels and mention @everyone when entering global security standby. */
    private async sendGlobalSecurityStandbyAlert(email: string, reason: string): Promise<void> {
        try {
            const { ConclusionWebhook } = await import('./util/ConclusionWebhook')
            await ConclusionWebhook(
                this.config,
                '🚨 Global Security Standby Engaged',
                `@everyone\n\n**Account:** ${email}\n**Reason:** ${reason}\n**Action:** Pausing all further accounts. We will not proceed until this is resolved.\n\n_Security check by @Light_`,
                undefined,
                DISCORD.COLOR_RED
            )
        } catch (e) {
            rlog('main','ALERT',`Failed to send standby alert: ${e instanceof Error ? e.message : e}`,'warn')
        }
    }

    private async sendConclusion(summaries: AccountSummary[]) {
        const { ConclusionWebhookEnhanced } = await import('./util/ConclusionWebhook')
        const cfg = this.config

        const conclusionWebhookEnabled = !!(cfg.conclusionWebhook && cfg.conclusionWebhook.enabled)
        const ntfyEnabled = !!(cfg.ntfy && cfg.ntfy.enabled)
        const webhookEnabled = !!(cfg.webhook && cfg.webhook.enabled)

        const totalAccounts = summaries.length
        if (totalAccounts === 0) return

        let totalCollected = 0
        let totalInitial = 0
        let totalEnd = 0
        let totalDuration = 0
        let accountsWithErrors = 0
        let accountsBanned = 0
        let successes = 0

        // Calculate summary statistics
        for (const s of summaries) {
            totalCollected += s.totalCollected
            totalInitial += s.initialTotal
            totalEnd += s.endTotal
            totalDuration += s.durationMs
            if (s.banned?.status) accountsBanned++
            if (s.errors.length) accountsWithErrors++
            if (!s.banned?.status && !s.errors.length) successes++
        }

        const avgDuration = totalDuration / totalAccounts
        const avgPointsPerAccount = Math.round(totalCollected / totalAccounts)

        // Read package version
        let version = 'unknown'
        try {
            const pkgPath = path.join(process.cwd(), 'package.json')
            if (fs.existsSync(pkgPath)) {
                const raw = fs.readFileSync(pkgPath, 'utf-8')
                const pkg = JSON.parse(raw)
                version = pkg.version || version
            }
        } catch { /* ignore */ }

        // Send enhanced webhook
        if (conclusionWebhookEnabled || ntfyEnabled || webhookEnabled) {
            await ConclusionWebhookEnhanced(cfg, {
                version,
                runId: this.runId,
                totalAccounts,
                successes,
                accountsWithErrors,
                accountsBanned,
                totalCollected,
                totalInitial,
                totalEnd,
                avgPointsPerAccount,
                totalDuration,
                avgDuration,
                summaries
            })
        }

        // Write local JSON report
        try {
            const fs = await import('fs')
            const path = await import('path')
            const now = new Date()
            const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
            const baseDir = path.join(process.cwd(), 'reports', day)
            if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true })
            const file = path.join(baseDir, `summary_${this.runId}.json`)
            const payload = {
                runId: this.runId,
                timestamp: now.toISOString(),
                totals: { totalCollected, totalInitial, totalEnd, totalDuration, totalAccounts, accountsWithErrors },
                perAccount: summaries
            }
            fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')
            rlog('main','REPORT',`Saved report to ${file}`)
        } catch (e) {
            rlog('main','REPORT',`Failed to save report: ${e instanceof Error ? e.message : e}`,'warn')
        }

        // Cleanup old diagnostics
        try {
            const days = cfg.diagnostics?.retentionDays
            if (typeof days === 'number' && days > 0) {
                await this.cleanupOldDiagnostics(days)
            }
        } catch (e) {
            rlog('main','REPORT',`Failed diagnostics cleanup: ${e instanceof Error ? e.message : e}`,'warn')
        }

        // Optional community notice (shown randomly in ~15% of successful runs)
        if (Math.random() > 0.85 && successes > 0 && accountsWithErrors === 0) {
            rlog('main','INFO','Want faster updates & enhanced anti-detection? Community builds available: https://discord.gg/kn3695Kx32')
        }
    }

    /** Reserve one diagnostics slot for this run (caps captures). */
    public tryReserveDiagSlot(maxPerRun: number): boolean {
        if (this.diagCount >= Math.max(0, maxPerRun || 0)) return false
        this.diagCount += 1
        return true
    }

    /** Delete diagnostics folders older than N days under ./reports */
    private async cleanupOldDiagnostics(retentionDays: number) {
        const base = path.join(process.cwd(), 'reports')
        if (!fs.existsSync(base)) return
        const entries = fs.readdirSync(base, { withFileTypes: true })
        const now = Date.now()
        const keepMs = retentionDays * 24 * 60 * 60 * 1000
        for (const e of entries) {
            if (!e.isDirectory()) continue
            const name = e.name // expect YYYY-MM-DD
            const parts = name.split('-').map((n: string) => parseInt(n, 10))
            if (parts.length !== 3 || parts.some(isNaN)) continue
            const [yy, mm, dd] = parts
            if (yy === undefined || mm === undefined || dd === undefined) continue
            const dirDate = new Date(yy, mm - 1, dd).getTime()
            if (isNaN(dirDate)) continue
            if (now - dirDate > keepMs) {
                const dirPath = path.join(base, name)
                try { fs.rmSync(dirPath, { recursive: true, force: true }) } catch { /* ignore */ }
            }
        }
    }

    // Run optional auto-update script based on configuration flags.
    private async runAutoUpdate(): Promise<void> {
        const upd = this.config.update
        if (!upd) return
        const scriptRel = upd.scriptPath || 'setup/update/update.mjs'
        const scriptAbs = path.join(process.cwd(), scriptRel)
        if (!fs.existsSync(scriptAbs)) return

        const args: string[] = []
        // Git update is enabled by default (unless explicitly set to false)
        if (upd.git !== false) args.push('--git')
        if (upd.docker) args.push('--docker')
        if (args.length === 0) return

        // Pass scheduler flag to update script so it doesn't exit
        const isSchedulerMode = !!process.env.SCHEDULER_HEARTBEAT_FILE
        const env = isSchedulerMode
            ? { ...process.env, FROM_SCHEDULER: '1' }
            : process.env

        await new Promise<void>((resolve) => {
            const child = spawn(process.execPath, [scriptAbs, ...args], { stdio: 'inherit', env })
            child.on('close', () => resolve())
            child.on('error', () => resolve())
        })
    }
}

function shortErr(e: unknown): string {
    if (e == null) return 'unknown'
    if (e instanceof Error) return e.message.substring(0, 120)
    const s = String(e)
    return s.substring(0, 120)
}



async function main() {
    const rewardsBot = new MicrosoftRewardsBot(false)

    const crashState = { restarts: 0 }
    const config = rewardsBot.config

    const attachHandlers = () => {
        process.on('unhandledRejection', (reason) => {
            rlog('main','FATAL','UnhandledRejection: ' + (reason instanceof Error ? reason.message : String(reason)), 'error')
            gracefulExit(1)
        })
        process.on('uncaughtException', (err) => {
            rlog('main','FATAL','UncaughtException: ' + err.message, 'error')
            gracefulExit(1)
        })
        process.on('SIGTERM', () => gracefulExit(0))
        process.on('SIGINT', () => gracefulExit(0))
    }

    const gracefulExit = (code: number) => {
        try { rewardsBot['heartbeatTimer'] && clearInterval(rewardsBot['heartbeatTimer']) } catch { /* ignore */ }
        if (config?.crashRecovery?.autoRestart && code !== 0) {
            const max = config.crashRecovery.maxRestarts ?? 2
            if (crashState.restarts < max) {
                const backoff = (config.crashRecovery.backoffBaseMs ?? 2000) * (crashState.restarts + 1)
                rlog('main','CRASH-RECOVERY',`Scheduling restart in ${backoff}ms (attempt ${crashState.restarts + 1}/${max})`, 'warn','yellow')
                setTimeout(() => {
                    crashState.restarts++
                    bootstrap()
                }, backoff)
                return
            }
        }
        process.exit(code)
    }

    const bootstrap = async () => {
        try {
            await rewardsBot.initialize()
            await rewardsBot.run()
        } catch (e) {
            rlog('main','MAIN-ERROR','Fatal during run: ' + (e instanceof Error ? e.message : e),'error')
            gracefulExit(1)
        }
    }

    attachHandlers()
    await bootstrap()
}

// Start the bots
if (require.main === module) {
    main().catch(error => {
        rlog('main', 'MAIN-ERROR', `Error running bots: ${error}`, 'error')
        process.exit(1)
    })
}