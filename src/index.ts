import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import { randomInt } from 'crypto'
import pkg from '../package.json'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtils from './browser/BrowserUtils'

import { IpcLog, Logger } from './logging/Logger'
import Utils from './util/Utils'
import { loadAccounts, loadConfig } from './util/Load'
import { checkNodeVersion } from './util/Validator'

import { Login } from './browser/auth/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'
import { SearchManager } from './functions/SearchManager'
import NextParser from './util/NextParser'

import type { Account } from './interface/Account'
import AxiosClient from './util/Axios'
import { sendDiscord, flushDiscordQueue } from './logging/Discord'
import { sendNtfy, flushNtfyQueue } from './logging/Ntfy'
import type { DashboardData } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'
import type { PanelFlyoutData } from './interface/PanelFlyoutData'


interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
}

const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        return { isMobile: false, account: {} as any }
    }
    return context
}

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([flushDiscordQueue(timeoutMs), flushNtfyQueue(timeoutMs)])
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
}

export class MicrosoftRewardsBot {
    public logger: Logger
    public config
    public utils: Utils
    public nextParser: NextParser = new NextParser()
    public activities: Activities = new Activities(this)
    public browser: { func: BrowserFunc; utils: BrowserUtils }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page

    public userData: UserData

    public rewardsVersion: 'legacy' | 'modern' = 'legacy'
    public panelData!: PanelFlyoutData

    public accessToken = ''
    public requestToken = ''
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
    public fingerprint!: BrowserFingerprintWithHeaders

    private pointsCanCollect = 0

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private workers: Workers
    private login = new Login(this)
    private searchManager: SearchManager

    public axios!: AxiosClient

    constructor() {
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0
        }
        this.logger = new Logger(this)
        this.accounts = []
        this.cookies = { mobile: [], desktop: [] }
        this.utils = new Utils()
        this.workers = new Workers(this)
        this.searchManager = new SearchManager(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtils(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
        this.exitedWorkers = []
    }
    private async randomDelayBetween(minMinutes: number, maxMinutes: number): Promise<void> {
        const minMs = minMinutes * 60 * 1000
        const maxMs = maxMinutes * 60 * 1000
        const delay = randomInt(minMs, maxMs + 1)

        this.logger.info(
            'main',
            'DELAY',
            `Waiting ${(delay / 60000).toFixed(2)} minutes before next account...`
        )

        await new Promise(resolve => setTimeout(resolve, delay))
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
    }

    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${this.config.clusters}`
        )

        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                await this.runMaster(runStartTime)
            } else {
                this.runWorker(runStartTime)
            }
        } else {
            await this.runTasks(this.accounts, runStartTime)
        }
    }

    private async runMaster(runStartTime: number): Promise<void> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
        const accountChunks = rawChunks.filter(c => c && c.length > 0)
        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []
        let hadWorkerFailure = false

        // Helper function to fork a worker with message handling
        const forkWorker = (chunk: Account[]) => {
            const worker = cluster.fork()
            worker.send?.({ chunk, runStartTime })

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }

                const log = msg.__ipcLog
                if (log && typeof log.content === 'string') {
                    const { webhook } = this.config
                    const { content, level } = log

                    // Webhooks, for later expansion?
                    if (webhook.discord?.enabled && webhook.discord.url) {
                        sendDiscord(webhook.discord.url, content, level)
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        sendNtfy(webhook.ntfy, content, level)
                    }
                }
            })
        }

        // Start the first worker immediately
        const firstChunk = accountChunks[0]
        if (firstChunk) {
            forkWorker(firstChunk)
        }

        // Start each remaining worker with its own independent random 30-50 minute delay
        const workerPromises: Promise<void>[] = []
        for (let i = 1; i < accountChunks.length; i++) {
            const chunk = accountChunks[i]
            if (!chunk) continue

            const delayMinutes = 30 + (randomInt(0, 20000000) / 1000000) // Each worker gets its own random 30-50 min delay
            const delayMs = delayMinutes * 60 * 1000
            const workerIndex = i

            const promise = (async () => {
                this.logger.info(
                    'main',
                    'CLUSTER-DELAY',
                    `Worker ${workerIndex + 1} will start in ${(delayMs / 60000).toFixed(2)} minutes...`
                )
                await new Promise(resolve => setTimeout(resolve, delayMs))
                this.logger.info('main', 'CLUSTER-START', `Starting worker ${workerIndex + 1}...`)
                forkWorker(chunk)
            })()

            workerPromises.push(promise)
        }

        // Wait for all worker delays to complete (workers will continue running)
        await Promise.allSettled(workerPromises)

        const onWorkerExit = async (worker: Worker, code?: number, signal?: string): Promise<void> => {
            const { pid } = worker.process

            if (!pid || this.exitedWorkers.includes(pid)) {
                return
            }

            this.exitedWorkers.push(pid)
            this.activeWorkers -= 1

            // exit 0 = good, exit 1 = crash
            const failed = (code ?? 0) !== 0 || Boolean(signal)
            if (failed) {
                hadWorkerFailure = true
            }

            this.logger.warn(
                'main',
                'CLUSTER-WORKER-EXIT',
                `Worker ${pid} exit | Code: ${code ?? 'n/a'} | Signal: ${signal ?? 'n/a'} | Active workers: ${this.activeWorkers}`
            )

            if (this.activeWorkers <= 0) {
                const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.logger.info(
                    'main',
                    'RUN-END',
                    `Completed all accounts | Accounts processed: ${allAccountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                    'green'
                )

                await flushAllWebhooks()

                process.exit(hadWorkerFailure ? 1 : 0)
            }
        }

        cluster.on('exit', (worker, code, signal) => {
            void onWorkerExit(worker, code ?? undefined, signal ?? undefined)
        })

        cluster.on('disconnect', worker => {
            const pid = worker.process?.pid
            this.logger.warn('main', 'CLUSTER-WORKER-DISCONNECT', `Worker ${pid ?? '?'} disconnected`) // <-- Warning only
        })
    }

    private runWorker(runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `Worker spawned | PID: ${process.pid}`)

        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            void this.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `Worker ${process.pid} received ${chunk.length} accounts.`
            )

            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())

                // Send and flush before exit
                if (process.send) {
                    process.send({ __stats: stats })
                }

                await flushAllWebhooks()
                process.exit(0)
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `Worker task crash: ${error instanceof Error ? error.message : String(error)}`
                )

                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []

        let isFirstAccount = true // ✅ track first account

        for (const account of accounts) {

            // ✅ Delay ONLY if not first account
            if (!isFirstAccount && this.config.clusters > 1) {
                await this.randomDelayBetween(35, 50)
            }

            isFirstAccount = false

            const accountStartTime = Date.now()
            const accountEmail = account.email
            this.userData.userName = this.utils.getEmailUsername(accountEmail)

            try {
                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `Starting account: ${accountEmail} | geoLocale: ${account.geoLocale}`
                )

                this.axios = new AxiosClient(account.proxy)

                const result: { initialPoints: number; collectedPoints: number } | undefined = await this.Main(
                    account
                ).catch(error => {
                    void this.logger.error(
                        true,
                        'FLOW',
                        `Mobile flow failed for ${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                    )
                    return undefined
                })

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = accountInitialPoints + collectedPoints

                    accountStats.push({
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints,
                        duration: parseFloat(durationSeconds),
                        success: true
                    })

                    this.logger.info(
                        'main',
                        'ACCOUNT-END',
                        `Completed account: ${accountEmail} | Total: +${collectedPoints} | Old: ${accountInitialPoints} → New: ${accountFinalPoints} | Duration: ${durationSeconds}s`,
                        'green'
                    )
                } else {
                    accountStats.push({
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: 'Flow failed'
                    })
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                )

                accountStats.push({
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                })
            }
        }

        // ✅ keep your original ending logic unchanged
        if (this.config.clusters <= 1 && cluster.isPrimary) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            this.logger.info(
                'main',
                'RUN-END',
                `Completed all accounts | Accounts processed: ${accountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                'green'
            )

            await flushAllWebhooks()
            process.exit(0)
        }

        return accountStats
    }

    async Main(account: Account): Promise<{ initialPoints: number; collectedPoints: number }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)

                // ✅ Auto close cookie preferences popup if it appears
                try {
                    const cookieCloseButton = this.mainMobilePage.locator('[aria-label="Close cookie preferences"], [aria-label="Close"]:has-text("×"), button:has-text("×"), div[role="dialog"] button[aria-label="Close"]')
                    if (await cookieCloseButton.count() > 0) {
                        this.logger.debug(this.isMobile, 'COOKIE', 'Closing cookie preferences popup...')
                        await cookieCloseButton.click({ timeout: 2000 }).catch(() => {})
                        await this.utils.wait(this.utils.humanActivityDelay())
                    }
                } catch (cookieError) {
                    this.logger.debug(this.isMobile, 'COOKIE', `Cookie popup handler skipped: ${cookieError instanceof Error ? cookieError.message : String(cookieError)}`)
                }

                try {
                    this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                } catch (error) {
                    this.logger.error(
                        'main',
                        'FLOW',
                        `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
                    )
                }

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = mobileSession.fingerprint

                const data: DashboardData = await this.browser.func.getDashboardDataFromPage(this.mainMobilePage)
                const appData: AppDashboardData = await this.browser.func.getAppDashboardData()

                // Fetch panel flyout data (V4 alternative source)
                try {
                    this.panelData = await this.browser.func.getPanelFlyoutData()
                    this.logger.debug(this.isMobile, 'MAIN', 'Panel flyout data fetched successfully')
                } catch (error) {
                    this.logger.warn(this.isMobile, 'MAIN', `Failed to fetch panel flyout data: ${error}`)
                }

                // Set geo
                this.userData.geoLocale =
                    account.geoLocale === 'auto' ? data.userProfile.attributes.country : account.geoLocale.toLowerCase()

                this.userData.initialPoints = data.userStatus.availablePoints
                this.userData.currentPoints = data.userStatus.availablePoints
                const initialPoints = this.userData.initialPoints ?? 0

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints(data)
                const appEarnable = await this.browser.func.getAppEarnablePoints()

                this.pointsCanCollect = browserEarnable.mobileSearchPoints + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info(
                    'main',
                    'POINTS',
                    `Earnable today | Mobile: ${this.pointsCanCollect} | Browser: ${browserEarnable.mobileSearchPoints
                    } | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.userData.geoLocale}`
                )

                // ✅ Claim any pending points here - GUARANTEED EXECUTION
                try {
                    await this.workers.claimReadyPoints(this.mainMobilePage)
                } catch (claimError) {
                    this.logger.debug(this.isMobile, 'CLAIM-POINTS', `Claim points handler skipped: ${claimError instanceof Error ? claimError.message : String(claimError)}`)
                }


                // Randomly choose whether to do mobile or desktop activities first
                const doMobileFirst = randomInt(0, 2) === 0
                this.logger.info('main', 'FLOW', `Activity order: ${doMobileFirst ? 'Mobile first' : 'Desktop first'} | ${accountEmail}`)

                // Define mobile activities function with interleaving
                const doMobileActivities = async () => {
                    // Create array of activities with their conditions and functions
                    const mobileActivities = [
                        { condition: this.config.workers.doAppPromotions, fn: () => this.workers.doAppPromotions(appData), name: 'AppPromotions' },
                        { condition: this.config.workers.doDailySet, fn: () => this.workers.doDailySet(data, this.mainMobilePage), name: 'DailySet' },
                        { condition: this.config.workers.doSpecialPromotions, fn: () => this.workers.doSpecialPromotions(data), name: 'SpecialPromotions' },
                        { condition: this.config.workers.doQuests, fn: () => this.activities.doQuests(this.mainMobilePage), name: 'Quests' },
                        { condition: this.config.workers.doMorePromotions, fn: () => this.workers.doMorePromotions(data, this.mainMobilePage), name: 'MorePromotions' },
                        { condition: this.config.workers.doDailyCheckIn, fn: () => this.activities.doDailyCheckIn(), name: 'DailyCheckIn' },
                        { condition: this.config.workers.doReadToEarn, fn: () => this.activities.doReadToEarn(), name: 'ReadToEarn' },
                        { condition: this.config.workers.doPunchCards, fn: () => this.workers.doPunchCards(data, this.mainMobilePage), name: 'PunchCards' }
                    ]

                    // Filter activities based on conditions
                    const enabledActivities = mobileActivities.filter(a => a.condition)

                    // Shuffle the activities for random order
                    const shuffledActivities = this.utils.shuffleArray([...enabledActivities])

                    this.logger.info('main', 'ACTIVITY-ORDER', `Mobile activities order: ${shuffledActivities.map(a => a.name).join(' → ')}`)

                    // ✅ PROPER INTERLEAVING IMPLEMENTATION
                    // Track each activity type with its own queue
                    // Create separate queues for each activity type
                    const activityQueues = shuffledActivities.map(activity => ({
                        name: activity.name,
                        tasks: Array(activity.fn.length || 1).fill(activity.fn) as (() => Promise<void>)[],
                        completed: false
                    }))

                    let lastActivityType = ''
                    
                    while (activityQueues.some(q => !q.completed && q.tasks.length > 0)) {
                        try {
                            // Random distraction break (15% chance)
                            if (this.utils.shouldTakeDistractionBreak()) {
                                const distractionTime = this.utils.humanDistractionPause()
                                this.logger.info('main', 'DISTRACTION', `Taking a ${Math.round(distractionTime/1000)}s break...`)
                                await this.utils.wait(distractionTime)
                            }

                            // ✅ Pick a RANDOM DIFFERENT activity type that still has tasks
                            const availableQueues = activityQueues.filter(q => 
                                !q.completed && 
                                q.tasks.length > 0 && 
                                q.name !== lastActivityType
                            )
                            
                            // If only same type left, fall back to any available
                            const selectableQueues = availableQueues.length > 0 
                                ? availableQueues 
                                : activityQueues.filter(q => !q.completed && q.tasks.length > 0)
                            
                            const selectedQueue = selectableQueues[this.utils.randomNumber(0, selectableQueues.length)]!
                            lastActivityType = selectedQueue.name

                            // ✅ Do 2-5 tasks EXCLUSIVELY from this activity type
                            const batchSize = this.utils.randomNumber(2, 5)
                            const tasksToRun = Math.min(batchSize, selectedQueue.tasks.length)

                            this.logger.info('main', 'ACTIVITY-BATCH', `Starting ${tasksToRun}x ${selectedQueue.name} tasks`)
                            
                            for (let i = 0; i < tasksToRun; i++) {
                                const taskFn = selectedQueue.tasks.shift()
                                if (taskFn) {
                                    this.logger.info('main', 'ACTIVITY', `Executing ${selectedQueue.name} (${i + 1}/${tasksToRun})`)
                                    await taskFn()
                                    await this.utils.wait(this.utils.humanActivityDelay())
                                }
                            }

                            // Mark queue as completed if empty
                            if (selectedQueue.tasks.length === 0) {
                                selectedQueue.completed = true
                            }

                            // Interleave search tasks (33% chance between batches)
                            if (activityQueues.some(q => !q.completed && q.tasks.length > 0) && this.utils.randomNumber(1, 3) === 1) {
                                const searchBatchSize = this.utils.randomNumber(2, 5)
                                this.logger.info('main', 'SEARCH-INTERLEAVE', `Doing ${searchBatchSize} mobile searches...`)
                                try {
                                    await this.activities.doSearch(data, this.mainMobilePage, true, searchBatchSize)
                                } catch (searchError) {
                                    this.logger.error('main', 'SEARCH-ERROR', `Mobile search batch failed: ${searchError instanceof Error ? searchError.message : String(searchError)}`)
                                }
                            }
                        } catch (error) {
                            this.logger.error('main', 'ACTIVITY-ERROR', `Error in activity: ${error instanceof Error ? error.message : String(error)}`)
                        }
                    }
                }

                // Define desktop activities function with interleaving
                const doDesktopActivities = async () => {
                    this.logger.info('main', 'FLOW', `Switching to Desktop mode for ${accountEmail} to solve activities...`)
                    try {
                        await executionContext.run({ isMobile: false, account }, async () => {
                            await this.mainMobilePage.setViewportSize({ width: 1920, height: 1080 })
                            const desktopUA =
                                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.3856.62'
                            await (this.mainMobilePage.context() as any)._setExtraHTTPHeaders?.({ 'User-Agent': desktopUA })

                            this.logger.info('main', 'BROWSER', `Emulating Desktop view & User-Agent | ${accountEmail}`)

                            const desktopData: DashboardData = await this.browser.func.getDashboardDataFromPage(
                                this.mainMobilePage
                            )

                            // Create array of desktop activities with their conditions and functions
                            const desktopActivities = [
                                { condition: this.config.workers.doDailySet, fn: () => this.workers.doDailySet(desktopData, this.mainMobilePage), name: 'DesktopDailySet' },
                                { condition: this.config.workers.doMorePromotions, fn: () => this.workers.doMorePromotions(desktopData, this.mainMobilePage), name: 'DesktopMorePromotions' }
                            ]

                            // Filter activities based on conditions
                            const enabledDesktopActivities = desktopActivities.filter(a => a.condition)

                            // Shuffle the activities for random order
                            const shuffledDesktopActivities = this.utils.shuffleArray([...enabledDesktopActivities])

                            this.logger.info('main', 'ACTIVITY-ORDER', `Desktop activities order: ${shuffledDesktopActivities.map(a => a.name).join(' → ')}`)

                            // Execute activities in shuffled order with interleaving
                            let activityIndex = 0
                            while (activityIndex < shuffledDesktopActivities.length) {
                                try {
                                    // Random distraction break (15% chance)
                                    if (this.utils.shouldTakeDistractionBreak()) {
                                        const distractionTime = this.utils.humanDistractionPause()
                                        this.logger.info('main', 'DISTRACTION', `Taking a ${Math.round(distractionTime/1000)}s break...`)
                                        await this.utils.wait(distractionTime)
                                    }

                                    // Execute 2-5 activities from current type
                                    const batchSize = this.utils.randomNumber(2, 5)
                                    const endIndex = Math.min(activityIndex + batchSize, shuffledDesktopActivities.length)
                                    
                                    for (let i = activityIndex; i < endIndex; i++) {
                                        const activity = shuffledDesktopActivities[i]
                                        if (activity) {
                                            this.logger.info('main', 'ACTIVITY', `Executing ${activity.name} (${i - activityIndex + 1}/${batchSize})`)
                                            await activity.fn()
                                            // Add delay between activities
                                            await this.utils.wait(this.utils.humanActivityDelay())
                                        }
                                    }
                                    
                                    activityIndex = endIndex

                                    // Interleave search tasks (2-5 searches per batch)
                                    if (activityIndex < shuffledDesktopActivities.length && this.utils.randomNumber(1, 3) === 1) {
                                        const searchBatchSize = this.utils.randomNumber(2, 5)
                                        this.logger.info('main', 'SEARCH-INTERLEAVE', `Doing ${searchBatchSize} desktop searches...`)
                                        try {
                                            await this.activities.doSearch(desktopData, this.mainMobilePage, false, searchBatchSize)
                                        } catch (searchError) {
                                            this.logger.error('main', 'SEARCH-ERROR', `Desktop search batch failed: ${searchError instanceof Error ? searchError.message : String(searchError)}`)
                                        }
                                    }
                                } catch (error) {
                                    this.logger.error('main', 'ACTIVITY-ERROR', `Error in activity: ${error instanceof Error ? error.message : String(error)}`)
                                    activityIndex++
                                }
                            }

                            await (this.mainMobilePage.context() as any)._setExtraHTTPHeaders?.({
                                'User-Agent': mobileSession!.fingerprint.headers['User-Agent']
                            })
                        })
                    } catch (desktopError) {
                        this.logger.error('main', 'DESKTOP-SESSION', `Error during desktop emulation: ${desktopError}`)
                    }
                }

                // Execute activities in random order
                if (doMobileFirst) {
                    await doMobileActivities()
                    await doDesktopActivities()
                } else {
                    await doDesktopActivities()
                    await doMobileActivities()
                }

                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)

                this.cookies.mobile = await initialContext.cookies()

                const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(
                    data,
                    missingSearchPoints,
                    mobileSession,
                    account,
                    accountEmail
                )

                mobileContextClosed = true

                this.userData.gainedPoints = mobilePoints + desktopPoints

                const finalPoints = await this.browser.func.getCurrentPoints()
                const collectedPoints = finalPoints - initialPoints

                this.logger.info(
                    'main',
                    'FLOW',
                    `Collected: +${collectedPoints} | Mobile: +${mobilePoints} | Desktop: +${desktopPoints} | ${accountEmail}`
                )

                return {
                    initialPoints,
                    collectedPoints: collectedPoints || 0
                }
            })
        } finally {
            if (mobileSession && !mobileContextClosed) {
                try {
                    await executionContext.run({ isMobile: true, account }, async () => {
                        await this.browser.func.closeBrowser(mobileSession!.context, accountEmail)
                    })
                } catch { }
            }
        }
    }
}

export { executionContext }

async function main(): Promise<void> {
    // Check before doing anything
    checkNodeVersion()
    const rewardsBot = new MicrosoftRewardsBot()

    process.on('beforeExit', () => {
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
    }
}

main().catch(async error => {
    const tmpBot = new MicrosoftRewardsBot()
    tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
    await flushAllWebhooks()
    process.exit(1)
})
