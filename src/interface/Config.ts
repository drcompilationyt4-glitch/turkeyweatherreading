// src/interface/Config.ts

export interface Config {
    // Basic runtime & session
    baseURL: string;
    sessionPath: string;

    // Legacy single-level headless flag (still supported) and optional nested browser config
    headless: boolean;
    browser?: ConfigBrowser;

    // Fingerprinting config (new nested), keeps legacy saveFingerprint under it if desired
    fingerprinting?: ConfigFingerprinting;

    // Execution & concurrency
    parallel: boolean;
    runOnZeroPoints: boolean;
    clusters: number;

    // Fingerprint persistence (top-level kept for back-compat)
    saveFingerprint: ConfigSaveFingerprint;

    // Worker feature toggles
    workers: ConfigWorkers;

    // Search / query settings
    searchOnBingLocalQueries: boolean;
    searchSettings: ConfigSearchSettings;

    // Misc runtime controls
    globalTimeout: number | string;
    passesPerRun?: number;
    dryRun?: boolean; // simulate without executing

    // Anti-ban humanization & retry
    humanization?: ConfigHumanization; // Anti-ban humanization controls
    retryPolicy?: ConfigRetryPolicy; // Global retry/backoff policy

    // Job state persistence (checkpointing)
    jobState?: ConfigJobState;

    // Logging controls
    logExcludeFunc: string[];            // legacy placement for excludes
    webhookLogExcludeFunc: string[];     // legacy placement for webhook excludes
    logging?: ConfigLogging;             // richer logging config (live webhook, redaction etc.)

    // Networking / proxy
    proxy: ConfigProxy;

    // Webhooks & notifications
    webhook: ConfigWebhook;
    conclusionWebhook?: ConfigWebhook; // Optional secondary webhook for final summary
    ntfy: ConfigNtfy;

    // Diagnostics & updates
    diagnostics?: ConfigDiagnostics;
    update?: ConfigUpdate;

    // Scheduling
    schedule?: ConfigSchedule;

    // Optional features
    buyMode?: ConfigBuyMode; // Optional manual spending mode
    vacation?: ConfigVacation; // Optional monthly contiguous off-days
    crashRecovery?: ConfigCrashRecovery; // Automatic restart / graceful shutdown

    // New / advanced features
    riskManagement?: ConfigRiskManagement; // Risk-aware throttling and ban prediction
    analytics?: ConfigAnalytics;           // Performance dashboard and metrics tracking
    queryDiversity?: ConfigQueryDiversity; // Multi-source query generation
}

/* ---------------------------
   Sub-interfaces & helpers
   --------------------------- */

export interface ConfigBrowser {
    headless?: boolean;
    globalTimeout?: number | string;
}

export interface ConfigFingerprinting {
    saveFingerprint?: ConfigSaveFingerprint;
}

export interface ConfigSaveFingerprint {
    mobile: boolean;
    desktop: boolean;
}

export interface ConfigSearchSettings {
    useGeoLocaleQueries: boolean;
    scrollRandomResults: boolean;
    clickRandomResults: boolean;
    searchDelay: ConfigSearchDelay;
    retryMobileSearchAmount: number;
    localFallbackCount?: number; // Number of local fallback queries to sample when trends fail
    extraFallbackRetries?: number; // Additional mini-retry loops with fallback terms
}

export interface ConfigSearchDelay {
    min: number | string;
    max: number | string;
}

export interface ConfigWebhook {
    enabled: boolean;
    url: string;
    /** Optional: custom username for webhook messages (defaults to "Microsoft Rewards") */
    username?: string;
    /** Optional: custom avatar url for webhook messages */
    avatarUrl?: string;
}

export interface ConfigNtfy {
    enabled: boolean;
    url: string;
    topic: string;
    authToken?: string; // Optional authentication token
}

export interface ConfigProxy {
    proxyGoogleTrends: boolean;
    proxyBingTerms: boolean;
}

export interface ConfigDiagnostics {
    enabled?: boolean; // master toggle
    saveScreenshot?: boolean; // capture .png
    saveHtml?: boolean; // capture .html
    maxPerRun?: number; // cap number of captures per run
    retentionDays?: number; // delete older diagnostic folders
}

export interface ConfigUpdate {
    git?: boolean; // if true, run git pull + npm ci + npm run build after completion
    docker?: boolean; // if true, run docker update routine (compose pull/up) after completion
    scriptPath?: string; // optional custom path to update script relative to repo root
    autoUpdateConfig?: boolean; // if true, allow auto-update of config.jsonc when remote changes it
    autoUpdateAccounts?: boolean; // if true, allow auto-update of accounts.json when remote changes it
}

export interface ConfigBuyMode {
    enabled?: boolean; // if true, force buy mode session
    maxMinutes?: number; // session duration cap
}

export interface ConfigSchedule {
    enabled?: boolean;
    time?: string; // Back-compat: accepts "HH:mm" or "h:mm AM/PM"
    // New optional explicit times
    time12?: string; // e.g., "9:00 AM"
    time24?: string; // e.g., "09:00"
    timeZone?: string; // IANA TZ e.g., "America/New_York"
    useAmPm?: boolean; // prefer time12 vs time24
    runImmediatelyOnStart?: boolean; // if true, run once immediately when process starts
    cron?: string | string[]; // Optional cron expression(s) for advanced scheduling
}

export interface ConfigVacation {
    enabled?: boolean; // default false
    minDays?: number; // default 3
    maxDays?: number; // default 5
}

export interface ConfigCrashRecovery {
    autoRestart?: boolean; // Restart the root process after fatal crash
    maxRestarts?: number; // Max restart attempts (default 2)
    backoffBaseMs?: number; // Base backoff before restart (default 2000)
    restartFailedWorker?: boolean; // attempt to respawn crashed worker
    restartFailedWorkerAttempts?: number; // attempts per worker (default 1)
}

export interface ConfigWorkers {
    doDailySet: boolean;
    doMorePromotions: boolean;
    doPunchCards: boolean;
    doDesktopSearch: boolean;
    doMobileSearch: boolean;
    doDailyCheckIn: boolean;
    doReadToEarn: boolean;
    bundleDailySetWithSearch?: boolean; // If true, run desktop search right after Daily Set
}

/* Anti-ban humanization */
export interface ConfigHumanization {
    enabled?: boolean; // Master toggle for Human Mode
    stopOnBan?: boolean; // If true, stop processing remaining accounts after a ban is detected
    immediateBanAlert?: boolean; // If true, send an immediate webhook/NTFY alert when a ban is detected
    actionDelay?: { min: number | string; max: number | string }; // Additional random waits between actions
    gestureMoveProb?: number; // Probability [0..1] to perform micro mouse moves per step
    gestureScrollProb?: number; // Probability [0..1] to perform tiny scrolls per step
    allowedWindows?: string[]; // Execution windows (e.g. ["09:00-17:00"])
    randomOffDaysPerWeek?: number; // Randomly skip N days per week (0-7)
}

/* Retry/backoff policy */
export interface ConfigRetryPolicy {
    maxAttempts?: number; // default 3
    baseDelay?: number | string; // default 1000ms
    maxDelay?: number | string; // default 30s
    multiplier?: number; // default 2
    jitter?: number; // 0..1; default 0.2
}

/* Job state persistence */
export interface ConfigJobState {
    enabled?: boolean; // default true
    dir?: string; // base directory; defaults to <sessionPath>/job-state
}

/* Logging */
export interface ConfigLoggingLive {
    enabled?: boolean; // master switch for live webhook logs
    redactEmails?: boolean; // if true, redact emails in outbound logs
}

export interface ConfigLogging {
    excludeFunc?: string[];            // functions to exclude from logs
    webhookExcludeFunc?: string[];     // functions to exclude from webhook logs
    live?: ConfigLoggingLive;          // nested live logging controls
    liveWebhookUrl?: string;           // legacy/dedicated live webhook override
    redactEmails?: boolean;            // legacy top-level redaction flag
    [key: string]: unknown;            // forward compatibility
}

/* NEW FEATURES: Risk Management, Analytics, Query Diversity */
export interface ConfigRiskManagement {
    enabled?: boolean; // master toggle for risk-aware throttling
    autoAdjustDelays?: boolean; // automatically increase delays when risk is high
    stopOnCritical?: boolean; // halt execution if risk reaches critical level
    banPrediction?: boolean; // enable ML-style ban prediction
    riskThreshold?: number; // 0-100, pause if risk exceeds this
}

export interface ConfigAnalytics {
    enabled?: boolean; // track performance metrics
    retentionDays?: number; // how long to keep analytics data
    exportMarkdown?: boolean; // generate markdown reports
    webhookSummary?: boolean; // send analytics via webhook
}

export interface ConfigQueryDiversity {
    enabled?: boolean; // use multi-source query generation
    sources?: Array<'google-trends' | 'reddit' | 'news' | 'wikipedia' | 'local-fallback'>; // which sources to use
    maxQueriesPerSource?: number; // limit per source
    cacheMinutes?: number; // cache duration
}
