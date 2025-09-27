import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'

export class Quiz extends Workers {
    /**
     * Helper: hide any fixed/overlay elements that visually cover `sel` (temporary).
     * Returns number of elements hidden.
     */
    private async hideBlockingOverlays(page: Page, sel: string): Promise<number> {
        try {
            return await page.evaluate((selector) => {
                const target = document.querySelector(selector) as HTMLElement | null;
                if (!target) return 0;
                const tBox = target.getBoundingClientRect();
                const docElems = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
                let hiddenCount = 0;
                for (const el of docElems) {
                    try {
                        const style = window.getComputedStyle(el);
                        if (!style || style.display === 'none' || parseFloat(style.opacity || '1') === 0) continue;
                        const pos = style.position;
                        if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
                        const z = parseInt(style.zIndex || '0') || 0;
                        if (el === target) continue;
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        const overlap = !(r.right < tBox.left || r.left > tBox.right || r.bottom < tBox.top || r.top > tBox.bottom);
                        if (overlap && z >= 0) {
                            el.setAttribute('data-qa-hidden-temp', 'true');
                            (el as HTMLElement).style.setProperty('display', 'none', 'important');
                            hiddenCount++;
                        }
                    } catch { /* ignored for safety */ }
                }
                return hiddenCount;
            }, sel);
        } catch (e) {
            return 0;
        }
    }

    /**
     * Find candidate elements for daily activities if the provided selector fails.
     */
    private async findDailyCandidates(page: Page): Promise<string[]> {
        try {
            const candidates: string[] = await page.evaluate(() => {
                const out: string[] = [];
                const els = Array.from(document.querySelectorAll('.pointLink:not(.contentContainer .pointLink)')) as HTMLElement[];
                const seen = new Set<string>();
                const dailyRegex = /dailyset|daily|global_daily|gamification_daily|dailyglobaloffer/i;

                for (const el of els) {
                    let anc: HTMLElement | null = el;
                    let dataId: string | null = null;
                    while (anc && anc !== document.body) {
                        if ((anc as HTMLElement).hasAttribute && (anc as HTMLElement).hasAttribute('data-bi-id')) {
                            dataId = (anc as HTMLElement).getAttribute('data-bi-id');
                            break;
                        }
                        anc = anc.parentElement;
                    }

                    if (dataId && dailyRegex.test(dataId)) {
                        const esc = dataId.replace(/"/g, '\\"');
                        const sel = `[data-bi-id="${esc}"] .pointLink:not(.contentContainer .pointLink)`;
                        if (!seen.has(sel)) { out.push(sel); seen.add(sel); }
                    } else {
                        try {
                            const parent = el.closest('[data-section]') || el.parentElement || document.body;
                            const idx = Array.from(parent.querySelectorAll('.pointLink')).indexOf(el);
                            const tag = parent && (parent as HTMLElement).tagName ? (parent as HTMLElement).tagName.toLowerCase() : 'div';
                            const sel = `${tag} .pointLink:not(.contentContainer .pointLink):nth-of-type(${idx + 1})`;
                            if (!seen.has(sel)) { out.push(sel); seen.add(sel); }
                        } catch {
                            // skip
                        }
                    }
                }

                const extras = Array.from(document.querySelectorAll('[data-bi-id]')) as HTMLElement[];
                for (const e of extras) {
                    const id = e.getAttribute('data-bi-id') || '';
                    if (dailyRegex.test(id) && id.toLowerCase().includes('child')) {
                        const esc = id.replace(/"/g, '\\"');
                        const sel = `[data-bi-id="${esc}"] .pointLink:not(.contentContainer .pointLink)`;
                        if (!seen.has(sel)) { out.push(sel); seen.add(sel); }
                    }
                }

                return out;
            });

            return candidates;
        } catch (err) {
            return [];
        }
    }

    /**
     * Click helper that retries up to maxAttempts.
     * Returns: { success: boolean, reason?: string, popup?: Page }
     */
    private async clickWithRetries(page: Page, selector: string, maxAttempts = 3, perAttemptTimeout = 10000): Promise<{ success: boolean, reason?: string, popup?: Page }> {
        const isVisibleAndClickable = async (sel: string) => {
            try {
                const handle = await page.$(sel);
                if (!handle) return { ok: false, reason: 'not-found' };
                try { await handle.scrollIntoViewIfNeeded?.({ timeout: 2000 }); } catch {
                    await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null;
                        if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
                    }, sel);
                }

                const box = await handle.boundingBox();
                const visible = await page.evaluate((s) => {
                    const el = document.querySelector(s) as HTMLElement | null;
                    if (!el) return { display: 'none', visibility: 'hidden', opacity: '0', hidden: true };
                    const style = window.getComputedStyle(el);
                    return { display: style.display, visibility: style.visibility, opacity: style.opacity, hidden: el.hasAttribute('hidden') };
                }, sel);

                if (!box || box.width === 0 || box.height === 0) return { ok: false, reason: 'zero-bounding-box' };
                if (visible.hidden || visible.display === 'none' || visible.visibility === 'hidden' || parseFloat(visible.opacity || '1') === 0) {
                    return { ok: false, reason: 'css-hidden' };
                }
                return { ok: true };
            } catch (err) {
                return { ok: false, reason: 'visibility-check-error' };
            }
        };

        // @ts-ignore
        const context = page.context ? page.context() : null;

        const tryClickOnce = async (sel: string, timeout: number): Promise<{ success: boolean, reason?: string, popup?: Page }> => {
            try {
                await page.waitForSelector(sel, { state: 'attached', timeout: Math.min(3000, timeout) });
            } catch {
                // not attached quickly; continue
            }

            const visibility = await isVisibleAndClickable(sel);
            if (!visibility.ok) {
                this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: selector not visible/clickable (${visibility.reason}): ${sel}`, 'warn');
                if (visibility.reason === 'css-hidden') {
                    const hidden = await this.hideBlockingOverlays(page, sel);
                    if (hidden > 0) {
                        this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: hid ${hidden} overlay(s) covering ${sel}`);
                    }
                } else if (['not-found','zero-bounding-box'].includes(visibility.reason || '')) {
                    return { success: false, reason: visibility.reason };
                }
            }

            let popupPromise: Promise<Page | null> | null = null;
            if (context) {
                popupPromise = context.waitForEvent('page', { timeout: 1000 }).catch(() => null);
            }
            const navigationPromise = page.waitForNavigation({ timeout: 1000 }).catch(() => null);

            try {
                const locator = page.locator(sel).first();
                await locator.scrollIntoViewIfNeeded?.({ timeout: 2000 }).catch(() => null);
                await locator.click({ timeout }).catch(async (err) => {
                    this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: locator.click failed for ${sel} - trying evaluate click (${err})`, 'warn');
                    const clicked = await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null;
                        if (!el) return false;
                        el.click();
                        return true;
                    }, sel).catch(() => false);
                    if (!clicked) {
                        const h = await page.$(sel);
                        if (h) {
                            const box = await h.boundingBox();
                            if (box) {
                                await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
                            } else {
                                throw new Error('no-bounding-box-for-force-click');
                            }
                        } else {
                            throw new Error('element-missing-for-force-click');
                        }
                    }
                });
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: page click fallback for ${sel}: ${err}`, 'warn');
                try {
                    const locator = page.locator(sel).first();
                    await locator.click({ timeout, force: true }).catch(() => { throw new Error('force-click-failed'); });
                } catch (err2) {
                    this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: all click attempts failed for ${sel}: ${err2}`, 'error');
                    return { success: false, reason: 'click-failed' };
                }
            }

            const popup = popupPromise ? await popupPromise : null;
            const nav = await navigationPromise;

            if (popup) {
                try { await popup.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => null); } catch {}
                this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: click opened popup for ${sel}`);
                return { success: true, popup };
            }

            if (nav) {
                this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: click caused navigation for ${sel}`);
                return { success: true };
            }

            this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: click success for ${sel}`);
            return { success: true };
        };

        // 1) First, try the selector the caller provided
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const res = await tryClickOnce(selector, perAttemptTimeout);
            if (res.success) return res;
            if (res.reason === 'css-hidden' || res.reason === 'visibility-check-error') {
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 800));
                continue;
            } else {
                break;
            }
        }

        // 2) fallback heuristics
        const candidates = await this.findDailyCandidates(page);
        if (!candidates || candidates.length === 0) {
            this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: no fallback candidates found for ${selector}`, 'warn');
            return { success: false, reason: 'no-candidates' };
        }

        for (const candidate of candidates) {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const res = await tryClickOnce(candidate, perAttemptTimeout);
                if (res.success) return res;
                if (!['css-hidden','visibility-check-error','click-failed'].includes(res.reason || '')) break;
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 800));
            }
        }

        this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: exhausted attempts and candidates for ${selector}`, 'error');
        return { success: false, reason: 'max-retries' };
    }

    /**
     * Robustly fetch quiz data from the page (lightweight, multi-strategy).
     */
    private async fetchQuizData(page: Page, maxWaitMs = 3000): Promise<any | null> {
        const start = Date.now();

        const tryOnce = async (): Promise<any | null> => {
            try {
                // Strategy 1: direct global variable (two common places)
                const direct = await page.evaluate(() => {
                    // @ts-ignore
                    const _w = (window as any)._w;
                    // @ts-ignore
                    const r1 = (window as any).rewardsQuizRenderInfo;
                    if (_w && _w.rewardsQuizRenderInfo) return _w.rewardsQuizRenderInfo;
                    if (r1) return r1;
                    return null;
                });
                if (direct) return direct;

                // Strategy 2: search inline scripts for assignment and evaluate it inside page
                const scriptText = await page.evaluate(() => {
                    const tags = Array.from(document.scripts).map(s => s.textContent || '');
                    for (const t of tags) {
                        if (t && t.indexOf('rewardsQuizRenderInfo') !== -1) return t;
                    }
                    return null;
                });

                if (scriptText) {
                    const m = scriptText.match(/rewardsQuizRenderInfo\s*=\s*(\{[\s\S]*?\});/);
                    if (m && m[1]) {
                        const parsed = await page.evaluate((objText) => {
                            try { return new Function('return ' + objText)(); } catch { return null; }
                        }, m[1]);
                        if (parsed) return parsed;
                    }
                }

                // Strategy 3: DOM fallback (best-effort)
                const domFallback = await page.evaluate(() => {
                    const out: any = {};
                    out.showWelcomePanel = !!document.getElementById('rqStartQuiz');
                    const headerCredits = document.querySelector('.rqECredits, .rqWcCredits, #rqHeaderCredits .rqECredits') as HTMLElement | null;
                    out.earnedCredits = headerCredits ? parseInt(headerCredits.textContent || '0', 10) : 0;
                    const optionEls = Array.from(document.querySelectorAll('[id^=rqAnswerOption]')) as HTMLElement[];
                    out.numberOfOptions = optionEls.length || undefined;
                    out.options = optionEls.map(el => ({
                        id: el.id,
                        dataOption: el.getAttribute('data-option'),
                        isCorrect: (el.getAttribute('iscorrectoption') || '').toLowerCase()
                    }));
                    out.maxQuestions = undefined;
                    out.CorrectlyAnsweredQuestionCount = 0;
                    return out;
                });
                return domFallback || null;

            } catch (err) {
                return null;
            }
        };

        while (Date.now() - start < maxWaitMs) {
            const r = await tryOnce();
            if (r) return r;
            await this.bot.utils.wait(200);
        }

        return null;
    }

    /**
     * High-fidelity getQuizData that extracts many fields from window.rewardsQuizRenderInfo or DOM when available.
     */
    private async getQuizData(page: Page): Promise<any | null> {
        try {
            const quizData = await page.evaluate(() => {
                // @ts-ignore
                const wri = (window as any).rewardsQuizRenderInfo;
                if (wri) {
                    return {
                        maxQuestions: wri.maxQuestions,
                        CorrectlyAnsweredQuestionCount: wri.CorrectlyAnsweredQuestionCount,
                        numberOfOptions: wri.numberOfOptions,
                        correctAnswer: wri.correctAnswer,
                        isMultiChoiceQuizType: wri.isMultiChoiceQuizType,
                        isListicleQuizType: wri.isListicleQuizType,
                        isWOTQuizType: wri.isWOTQuizType,
                        isPutInOrderQuizType: wri.isPutInOrderQuizType,
                        isDemoEnabled: wri.isDemoEnabled,
                        isMobile: wri.isMobile,
                        isOverlayMinimized: wri.isOverlayMinimized,
                        isDailySetFlightEnabled: wri.isDailySetFlightEnabled,
                        isPartialPointsEnabled: wri.isPartialPointsEnabled,
                        quizId: wri.quizId,
                        offerId: wri.offerId,
                        currentQuestionNumber: wri.currentQuestionNumber,
                        earnedCredits: wri.earnedCredits,
                        maxCredits: wri.maxCredits,
                        userAlreadyClickedOptions: wri.userAlreadyClickedOptions,
                        recentAnswerChoice: wri.recentAnswerChoice,
                        isCurrentQuestionCompleted: wri.isCurrentQuestionCompleted,
                        showWelcomePanel: wri.showWelcomePanel,
                        quizRenderSummaryPage: wri.quizRenderSummaryPage,
                        showJoinRewardsPage: wri.showJoinRewardsPage,
                        enableDailySetWelcomePane: wri.enableDailySetWelcomePane,
                        isDailySetUrlOffer: wri.isDailySetUrlOffer,
                        dailySetUrlOfferId: wri.dailySetUrlOfferId,
                    };
                }
                return null;
            });

            if (quizData) return quizData;

            // If window.rewardsQuizRenderInfo is not available, try to extract data from DOM elements
            const quizDataFromDOM = await page.evaluate(() => {
                const creditsElement = document.querySelector('#rqHeaderCredits .rqECredits') as HTMLElement | null;
                const maxCreditsElement = document.querySelector('#rqHeaderCredits .rqMCredits') as HTMLElement | null;
                const questionStateElements = document.querySelectorAll('#rqHeaderCredits .filledCircle, #rqHeaderCredits .emptyCircle');
                const questionTextElement = document.querySelector('#rqQuestionTextPrimary') as HTMLElement | null;
                const answerOptionElements = document.querySelectorAll('[id^="rqAnswerOption"]');
                const timerElement = document.querySelector('#rqTimer') as HTMLElement | null;
                const questionStateElementsCount = questionStateElements.length;

                let completedQuestions = 0;
                questionStateElements.forEach((el) => {
                    if ((el as HTMLElement).classList.contains('filledCircle')) {
                        completedQuestions++;
                    }
                });

                const questionText = questionTextElement ? (questionTextElement.textContent || '').trim() : '';

                let correctAnswer: string | null = null;
                answerOptionElements.forEach((el) => {
                    try {
                        const isCorrect = (el as HTMLElement).getAttribute('iscorrectoption') === 'true';
                        if (isCorrect) {
                            correctAnswer = (el as HTMLElement).getAttribute('data-option') || ((el as HTMLElement).textContent || '').trim();
                        }
                    } catch {}
                });

                return {
                    earnedCredits: creditsElement ? (creditsElement.textContent || '').trim() : '0',
                    maxCredits: maxCreditsElement ? (maxCreditsElement.textContent || '').trim() : '0',
                    questionsCompleted: completedQuestions,
                    totalQuestions: questionStateElementsCount,
                    currentQuestionText: questionText,
                    numberOfOptions: answerOptionElements.length,
                    correctAnswer: correctAnswer,
                    timer: timerElement ? (timerElement.textContent || '').trim() : '',
                };
            });

            if (quizDataFromDOM) return quizDataFromDOM;
            return null;
        } catch (error: any) {
            this.bot.log(this.bot.isMobile, 'QUIZ', `getQuizData error: ${error?.message ?? error}`, 'warn');
            return null;
        }
    }

    /**
     * Heuristic: detect quiz completion using multiple signals (text patterns, element classes, absence of answer options).
     */
    private async isQuizComplete(page: Page): Promise<{ complete: boolean, reason?: string }> {
        try {
            const check = await page.evaluate(() => {
                const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
                const lc = bodyText.toLowerCase();

                const successPhrases = [
                    'great job', 'congratulations', 'you just earned', 'you earned', 'well done', 'nice job', 'quiz complete', 'completed the quiz', 'you have earned'
                ];
                for (const p of successPhrases) {
                    if (lc.indexOf(p) !== -1) return { complete: true, reason: `phrase:${p}` };
                }

                const earnedMatch = bodyText.match(/earned\s+(\d{1,4})\s+points?/i);
                if (earnedMatch) return { complete: true, reason: 'earned-points' };

                const completionSelectors = [
                    '.rqComplete', '.quiz-complete', '.rewards-complete', '.congrats', '#rqComplete', '.completePanel'
                ];
                for (const s of completionSelectors) {
                    try {
                        if (document.querySelector(s)) return { complete: true, reason: `selector:${s}` };
                    } catch { /* ignore invalid selectors */ }
                }

                const optionEls = Array.from(document.querySelectorAll('[id^=rqAnswerOption]')) as HTMLElement[];
                if (optionEls.length === 0) return { complete: true, reason: 'no-options' };

                return { complete: false };
            });

            return check;
        } catch (err) {
            return { complete: false, reason: 'check-error' };
        }
    }

    /**
     * Read current answer option states: visible & enabled heuristics.
     */
    private async getOptionStates(page: Page): Promise<Array<{ id: string, visible: boolean, enabled: boolean }>> {
        try {
            const states = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('[id^=rqAnswerOption]')) as HTMLElement[];
                return els.map(el => {
                    const id = el.id;
                    let visible = true;
                    let enabled = true;
                    try {
                        const style = window.getComputedStyle(el);
                        if (!style || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) visible = false;
                        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') enabled = false;
                        const cls = (el.className || '').toLowerCase();
                        if (cls.indexOf('disabled') !== -1 || cls.indexOf('ghost') !== -1 || cls.indexOf('used') !== -1) enabled = false;
                        const color = style.color || '';
                        if (color && (color.indexOf('rgba') !== -1 && color.indexOf('0.5') !== -1)) enabled = false;
                    } catch {}
                    return { id, visible, enabled };
                });
            });

            return states;
        } catch (err) {
            return [];
        }
    }

    /**
     * Brute-force fallback: click each visible/enabled answer option in sequence until completion.
     */
    private async bruteForceAnswers(page: Page): Promise<boolean> {
        try {
            const maxTotalAttempts = 40; // global cap
            let attempts = 0;
            const tried = new Set<string>();

            const early = await this.isQuizComplete(page);
            if (early.complete) {
                this.bot.log(this.bot.isMobile, 'QUIZ', `bruteForceAnswers: already complete (${early.reason})`);
                return true;
            }

            while (attempts < maxTotalAttempts) {
                attempts++;

                const opts = await this.getOptionStates(page);
                if (!opts || opts.length === 0) {
                    const comp = await this.isQuizComplete(page);
                    if (comp.complete) {
                        this.bot.log(this.bot.isMobile, 'QUIZ', `bruteForceAnswers: detected completion (no options) - ${comp.reason}`);
                        return true;
                    }
                    this.bot.log(this.bot.isMobile, 'QUIZ', 'bruteForceAnswers: no options found, aborting');
                    return false;
                }

                let chosen: string | null = null;
                for (const o of opts) {
                    if (o.visible && o.enabled && !tried.has(o.id)) {
                        chosen = `#${o.id}`;
                        break;
                    }
                }
                if (!chosen) {
                    for (const o of opts) {
                        if (o.visible && o.enabled) {
                            chosen = `#${o.id}`;
                            break;
                        }
                    }
                }

                if (!chosen) {
                    const comp2 = await this.isQuizComplete(page);
                    if (comp2.complete) {
                        this.bot.log(this.bot.isMobile, 'QUIZ', `bruteForceAnswers: completion detected (${comp2.reason})`);
                        return true;
                    }
                    this.bot.log(this.bot.isMobile, 'QUIZ', 'bruteForceAnswers: no enabled options available, aborting');
                    return false;
                }

                this.bot.log(this.bot.isMobile, 'QUIZ', `bruteForceAnswers: clicking fallback option ${chosen} (attempt ${attempts})`);
                const clickRes = await this.clickWithRetries(page, chosen, 2, 10000);
                if (!clickRes.success) {
                    this.bot.log(this.bot.isMobile, 'QUIZ', `bruteForceAnswers: click failed for ${chosen}: ${clickRes.reason}`, 'warn');
                    tried.add(chosen.replace(/^#/, ''));
                    await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900));
                    continue;
                }
                if (clickRes.popup) page = clickRes.popup;

                await this.bot.utils.wait(this.bot.utils.randomNumber(800, 1800));
                await this.bot.utils.wait(500);

                const comp = await this.isQuizComplete(page);
                if (comp.complete) {
                    this.bot.log(this.bot.isMobile, 'QUIZ', `bruteForceAnswers: completion detected after click (${comp.reason})`);
                    return true;
                }

                const statesAfter = await this.getOptionStates(page);
                const chosenId = chosen.replace(/^#/, '');
                const chosenState = statesAfter.find(s => s.id === chosenId);
                if (chosenState && (!chosenState.enabled || !chosenState.visible)) {
                    tried.add(chosenId);
                    this.bot.log(this.bot.isMobile, 'QUIZ', `bruteForceAnswers: option ${chosen} appears disabled/used after click, marking tried`);
                } else {
                    tried.add(chosenId);
                    this.bot.log(this.bot.isMobile, 'QUIZ', `bruteForceAnswers: option ${chosen} left enabled after click, marking tried (defensive)`);
                }

                await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1400));
            }

            this.bot.log(this.bot.isMobile, 'QUIZ', 'bruteForceAnswers: reached attempt cap without completing');
            return false;
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'QUIZ', `bruteForceAnswers: error ${err}`, 'error');
            return false;
        }
    }

    /**
     * Main runner for quiz.
     */
    async doQuiz(page: Page) {
        this.bot.log(this.bot.isMobile, 'QUIZ', 'Trying to complete quiz')

        try {
            // Attempt to click start if available (robust)
            const quizNotStarted = await page.waitForSelector('#rqStartQuiz', { state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)
            if (quizNotStarted) {
                const startClick = await this.clickWithRetries(page, '#rqStartQuiz', 3, 10000);
                if (!startClick.success) {
                    this.bot.log(this.bot.isMobile, 'QUIZ', `Could not click #rqStartQuiz after retries: ${startClick.reason}`, 'warn');
                    // fall through to attempt to continue anyway
                } else {
                    if (startClick.popup) page = startClick.popup;
                }
            } else {
                this.bot.log(this.bot.isMobile, 'QUIZ', 'Quiz has already been started, trying to finish it')
            }

            await this.bot.utils.wait(2000)

            // Prefer the global helper if present (external func)
            let quizData = null
            try { quizData = await this.bot.browser.func.getQuizData(page) } catch { quizData = null }

            // If not found, try class-local extractors
            if (!quizData) {
                quizData = await this.fetchQuizData(page, 1500) || await this.getQuizData(page).catch(() => null) || quizData;
            }

            // defensive guard: if structure not reliable, use brute-force fallback
            if (!quizData || typeof quizData.maxQuestions !== 'number' || typeof quizData.CorrectlyAnsweredQuestionCount !== 'number') {
                this.bot.log(this.bot.isMobile, 'QUIZ', 'Could not determine quiz length from quizData — falling back to brute-force strategy', 'warn');
                const bfOk = await this.bruteForceAnswers(page);
                if (!bfOk) {
                    try { await page.close(); } catch {}
                    this.bot.log(this.bot.isMobile, 'QUIZ', 'Brute-force fallback failed to complete quiz', 'error');
                    return;
                }
                await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000));
                try { await page.close(); } catch {}
                this.bot.log(this.bot.isMobile, 'QUIZ', 'Completed the quiz successfully (brute-force fallback)');
                return;
            }

            let questionsRemaining = quizData.maxQuestions - quizData.CorrectlyAnsweredQuestionCount // Amount of questions remaining

            // All questions
            for (let question = 0; question < questionsRemaining; question++) {
                // refresh quizData at top of loop to pick up changes
                quizData = await this.bot.browser.func.getQuizData(page).catch(() => null) || await this.fetchQuizData(page, 1500) || quizData;

                if (!quizData || typeof quizData.numberOfOptions !== 'number') {
                    this.bot.log(this.bot.isMobile, 'QUIZ', 'Quiz data invalid while looping, breaking out', 'warn');
                    break;
                }

                if (quizData.numberOfOptions === 8) {
                    const answers: string[] = []

                    for (let i = 0; i < quizData.numberOfOptions; i++) {
                        const sel = `#rqAnswerOption${i}`
                        const answerHandle = await page.waitForSelector(sel, { state: 'visible', timeout: 10000 }).catch(() => null)
                        const answerAttribute = await answerHandle?.evaluate((el: Element) => el.getAttribute('iscorrectoption')).catch(() => null)

                        if (answerAttribute && answerAttribute.toLowerCase() === 'true') {
                            answers.push(sel)
                        }
                    }

                    // Click the answers
                    for (const answer of answers) {
                        await page.waitForSelector(answer, { state: 'visible', timeout: 2000 }).catch(() => null)

                        // Click the answer using robust helper
                        const clickRes = await this.clickWithRetries(page, answer, 3, 12000);
                        if (!clickRes.success) {
                            this.bot.log(this.bot.isMobile, 'QUIZ', `Failed to click multi-answer ${answer}: ${clickRes.reason}`, 'warn');
                            continue;
                        }
                        if (clickRes.popup) page = clickRes.popup;

                        const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page)
                        if (!refreshSuccess) {
                            await page.close()
                            this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred, refresh was unsuccessful', 'error')
                            return
                        }
                    }

                } else if ([2, 3, 4].includes(quizData.numberOfOptions)) {
                    quizData = await this.bot.browser.func.getQuizData(page).catch(() => null) || quizData // Refresh Quiz Data
                    const correctOption = quizData.correctAnswer

                    let answeredThisRound = false
                    for (let i = 0; i < quizData.numberOfOptions; i++) {
                        const sel = `#rqAnswerOption${i}`
                        const answerHandle = await page.waitForSelector(sel, { state: 'visible', timeout: 10000 }).catch(() => null)
                        const dataOption = await answerHandle?.evaluate((el: Element) => el.getAttribute('data-option')).catch(() => null)

                        if (dataOption === correctOption) {
                            // Click the answer using robust helper
                            const clickRes = await this.clickWithRetries(page, sel, 3, 12000);
                            if (!clickRes.success) {
                                this.bot.log(this.bot.isMobile, 'QUIZ', `Failed to click correct option ${sel}: ${clickRes.reason}`, 'warn');
                                const retryRes = await this.clickWithRetries(page, sel, 1, 8000);
                                if (!retryRes.success) {
                                    this.bot.log(this.bot.isMobile, 'QUIZ', `Retry also failed for ${sel}, skipping.`, 'warn');
                                    break;
                                } else {
                                    if (retryRes.popup) page = retryRes.popup;
                                }
                            } else {
                                if (clickRes.popup) page = clickRes.popup;
                            }

                            const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page)
                            if (!refreshSuccess) {
                                await page.close()
                                this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred, refresh was unsuccessful', 'error')
                                return
                            }
                            answeredThisRound = true
                            break;
                        }
                    }

                    if (!answeredThisRound) {
                        this.bot.log(this.bot.isMobile, 'QUIZ', 'Could not determine correct option this round, falling back to brute-force attempt for this question', 'warn');
                        const bf = await this.bruteForceAnswers(page);
                        if (!bf) break;
                    }

                    await this.bot.utils.wait(2000)
                } else {
                    this.bot.log(this.bot.isMobile, 'QUIZ', `Unsupported or unknown numberOfOptions: ${quizData.numberOfOptions} - attempting brute-force fallback`, 'warn');
                    const bf2 = await this.bruteForceAnswers(page);
                    if (!bf2) break;
                }
            }

            // Done with
            await this.bot.utils.wait(2000)
            try { await page.close() } catch {}
            this.bot.log(this.bot.isMobile, 'QUIZ', 'Completed the quiz successfully')
        } catch (error) {
            // Attempt to capture diagnostics if available and configured
            try {
                const captureFn = (this.bot && this.bot.browser && this.bot.browser.utils && (this.bot.browser.utils as any).captureDiagnostics) ? (this.bot.browser.utils as any).captureDiagnostics : null;
                if (captureFn) {
                    try { await captureFn(page, 'quiz_error'); } catch { /* ignore */ }
                }
            } catch { /* ignore */ }

            try { await page.close() } catch {}
            this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred:' + error, 'error')
        }
    }
}
