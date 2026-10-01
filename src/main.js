import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { createClient } from '@supabase/supabase-js';

await Actor.init();

const supabaseUrl =
    process.env.SUPABASE_URL
    || 'https://ongqhvokcwceqgnetonq.supabase.co';

const supabaseServiceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceRoleKey) {
    throw new Error(
        'SUPABASE_SERVICE_ROLE_KEY is not configured.',
    );
}

const supabase = createClient(
    supabaseUrl,
    supabaseServiceRoleKey,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    },
);

const SUPABASE_BATCH_SIZE = 500;

/*
 * Each entry turns one key of the Revel JSON export into rows for one
 * Supabase table. `id` is a SHA-256 of primaryKeyFields joined by "|".
 */
const PRODUCT_COMBOS_EXTRACT = {
    key: 'productcombos',
    fields: [
        'product_category',
        'tax',
        'n_comps',
        'total',
        'n_items',
        'n_voids',
        'product_name',
        'product_class',
        'price',
        'product_subcategory',
        'discount',
        'order_discount',
    ],
    primaryKeyFields: [
        'business_date',
        'location',
        'product_class',
        'product_category',
        'product_subcategory',
        'product_name',
    ],
    keepRow: (row) => row.row_type === 'Parent_Product',
    filterDescription: 'keeping only Parent_Product rows',
};

const PRODUCT_MIX_EXTRACT = {
    key: 'productmix',
    fields: [
        'product_category',
        'n_comps',
        'gm',
        'total',
        'n_items',
        'n_voids',
        'product_name',
        'row_type',
        'product_class',
        'price',
        'product_subcategory',
        'discount',
        'order_discount',
    ],
    primaryKeyFields: [
        'business_date',
        'location',
        'row_type',
        'product_class',
        'product_category',
        'product_subcategory',
        'product_name',
    ],
    keepRow: (row) => (
        row.product_category !== null && row.product_category !== undefined
    ),
    filterDescription: 'keeping rows where product_category is not null',
};

const REPORT_NAME = 'Product Mix';
const TARGET_ESTABLISHMENT = 'Leander';
const CENTRAL_TIME_ZONE = 'America/Chicago';

const REPORT_START_TIME = { time: '12:00', meridiem: 'AM' };
const REPORT_END_TIME = { time: '11:59', meridiem: 'PM' };

const PANELS = {
    filters: {
        name: 'Filters',
        toggle: '.filters-area .filters-button',
        form: '#filter_form',
    },
    preferences: {
        name: 'Preferences',
        toggle: '.filters-area .preferences.button-toggle',
        form: '#detail_report_form',
    },
};

/*
 * Every other enabled checkbox in the Preferences form is unchecked.
 */
const PREFERENCE_RADIOS = [
    { id: 'sort_by_category', label: 'Sort by Category' },
    {
        id: 'include_all_separate_quantity',
        label: 'Include Voids/Returns & Comps in separate columns '
            + 'from Quantity',
    },
];

const PREFERENCE_CHECKBOXES = [
    { id: 'show_product', label: 'Product' },
    { id: 'split_combos', label: 'Split items sold as part of combos' },
    { id: 'item_discount', label: 'Item Discounts' },
    { id: 'order_discount', label: 'Order Discounts' },
];

/**
 * Capture a screenshot and save it in the run's
 * default key-value store.
 */
async function saveScreenshot(page, key) {
    const screenshot = await page.screenshot({
        fullPage: true,
    });

    await Actor.setValue(key, screenshot, {
        contentType: 'image/png',
    });

    log.info(`Saved screenshot: ${key}`);
}

function validateDate(value, fieldName) {
    const datePattern =
        /^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/\d{4}$/;

    if (!datePattern.test(value)) {
        throw new Error(
            `${fieldName} must use MM/DD/YYYY format. `
            + `Received: ${value}`,
        );
    }
}

/**
 * Calendar date for a moment in US Central Time.
 */
function getCentralDateParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: CENTRAL_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);

    const lookup = Object.fromEntries(
        parts
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, Number(part.value)]),
    );

    return {
        year: lookup.year,
        month: lookup.month,
        day: lookup.day,
    };
}

function formatDateParts({ year, month, day }) {
    const monthText = String(month).padStart(2, '0');
    const dayText = String(day).padStart(2, '0');

    return `${monthText}/${dayText}/${year}`;
}

/**
 * Default report date: yesterday in US Central Time, MM/DD/YYYY.
 */
function calculateReportDate(today = new Date()) {
    const { year, month, day } = getCentralDateParts(today);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));

    calendarDate.setUTCDate(calendarDate.getUTCDate() - 1);

    return formatDateParts({
        year: calendarDate.getUTCFullYear(),
        month: calendarDate.getUTCMonth() + 1,
        day: calendarDate.getUTCDate(),
    });
}

/**
 * Zero-pad a validated M/D/YYYY date; the picker parses dates strictly.
 */
function normalizeDate(value) {
    const [month, day, year] = value.split('/').map(Number);

    return formatDateParts({ year, month, day });
}

/**
 * Convert MM/DD/YYYY into YYYY-MM-DD.
 */
function toIsoDate(value) {
    const [month, day, year] = value.split('/');

    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

async function pollUntil(check, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await check()) return true;

        await new Promise((resolve) => {
            setTimeout(resolve, 200);
        });
    }

    return check();
}

async function hasClass(locator, className) {
    return locator.evaluate(
        (element, name) => element.classList.contains(name),
        className,
    );
}

async function isButtonDisabled(button) {
    return button.evaluate((element) => (
        element.disabled === true
        || element.classList.contains('disabled')
        || element.getAttribute('aria-disabled') === 'true'
    ));
}

/**
 * Revel renders checkboxes and radios as a hidden native input
 * inside a <label> with a custom-styled span, so the label is
 * what a user actually clicks.
 */
async function getToggleTarget(input) {
    const wrappingLabel = input.locator('xpath=ancestor::label[1]');

    if (await wrappingLabel.count() > 0) return wrappingLabel;

    const id = await input.getAttribute('id');

    if (id) {
        const forLabel = input.page().locator(`label[for="${id}"]`);

        if (await forLabel.count() > 0) return forLabel.first();
    }

    return input;
}

async function describeInput(input) {
    return input.evaluate((element) => {
        const label = element.closest('label')
            ?? (element.id
                ? document.querySelector(
                    `label[for="${CSS.escape(element.id)}"]`,
                )
                : null);

        const text = (label ?? element.parentElement)?.innerText ?? '';

        return text.replace(/\s+/g, ' ').trim()
            || element.id
            || element.name
            || 'unnamed input';
    });
}

/**
 * Revel greys out controls it manages (e.g. Class/Category once a sort
 * order is chosen) with CSS classes rather than the disabled attribute.
 */
async function isLocked(input) {
    return input.evaluate((element) => {
        if (
            element.disabled
            || element.getAttribute('aria-disabled') === 'true'
        ) {
            return true;
        }

        const listItem = element.closest('li');
        const stopAt = (listItem ?? element.parentElement)?.parentElement;

        for (
            let node = element;
            node && node !== stopAt;
            node = node.parentElement
        ) {
            if (node.classList.contains('disabled')) return true;
        }

        if (listItem?.querySelector('.disabled, [disabled]')) return true;

        const label = element.closest('label');

        if (!label) return false;

        const style = window.getComputedStyle(label);

        return style.pointerEvents === 'none' || Number(style.opacity) < 1;
    });
}

async function isInteractive(input) {
    const target = await getToggleTarget(input);

    return target.isVisible();
}

/**
 * Put a checkbox or radio into the requested state and verify it.
 * Returns true when the control had to be changed.
 */
async function setInputChecked(input, checked, description) {
    await input.waitFor({ state: 'attached', timeout: 15_000 });

    if ((await input.isChecked()) === checked) return false;

    if (await input.isDisabled()) {
        throw new Error(
            `"${description}" is disabled and cannot be `
            + `${checked ? 'checked' : 'unchecked'}.`,
        );
    }

    const reachedState = async () => (
        (await input.isChecked()) === checked
    );

    const target = await getToggleTarget(input);

    if (await target.isVisible()) {
        await target.click();
    }

    if (!(await pollUntil(reachedState, 2_000))) {
        await input.evaluate((element) => element.click());
    }

    if (!(await pollUntil(reachedState, 5_000))) {
        throw new Error(
            `"${description}" did not become `
            + `${checked ? 'checked' : 'unchecked'}.`,
        );
    }

    log.info(`${checked ? 'Selected' : 'Cleared'}: ${description}`);

    return true;
}

/**
 * Hidden loaders can remain in Revel's DOM permanently. Check
 * whether any matching loader is actually visible instead of
 * waiting for the elements to be detached.
 */
async function waitForReportIdle(page) {
    await page.waitForFunction(
        () => {
            const reportArea =
                document.querySelector('.report-content')
                ?? document.querySelector('.report-container')
                ?? document.querySelector('.reports-content')
                ?? document.body;

            const loadingElements = reportArea.querySelectorAll([
                '.loading',
                '.loader',
                '.spinner',
                '.loading-mask',
                '.blockUI',
                '.fa-spinner',
                '.icon-spinner',
                '[class*="loading-indicator"]',
            ].join(','));

            return [...loadingElements].every((element) => {
                const style = window.getComputedStyle(element);
                const bounds = element.getBoundingClientRect();

                return (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || style.opacity === '0'
                    || bounds.width === 0
                    || bounds.height === 0
                );
            });
        },
        undefined,
        {
            timeout: 90_000,
            polling: 500,
        },
    );

    /*
     * Give computed totals and charts a brief opportunity to settle
     * after the loading indicator disappears.
     */
    await page.waitForTimeout(1_500);
}

async function login(page, { url, username, password }) {
    await saveScreenshot(page, 'REVEL_LOGIN_START');

    const usernameField = page.locator('#username');

    await usernameField.waitFor({
        state: 'visible',
        timeout: 15_000,
    });

    await usernameField.fill(username);

    log.info('Username entered. Clicking Continue.');

    await page
        .getByRole('button', {
            name: 'Continue',
            exact: true,
        })
        .click();

    const passwordField = page.locator('input[type="password"]');

    await passwordField.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    log.info('Password field appeared.');

    await saveScreenshot(page, 'REVEL_PASSWORD_STEP');

    await passwordField.fill(password);

    const loginButton = page
        .locator(
            'button[type="submit"]:visible, '
            + 'input[type="submit"]:visible',
        )
        .last();

    await loginButton.waitFor({
        state: 'visible',
        timeout: 15_000,
    });

    const buttonText =
        (await loginButton.textContent())?.trim()
        || (await loginButton.getAttribute('value'))
        || 'Submit';

    log.info(`Clicking final login button: ${buttonText}`);

    await loginButton.click();

    await passwordField.waitFor({
        state: 'hidden',
        timeout: 30_000,
    });

    await page.waitForLoadState('domcontentloaded');

    log.info(`Login completed. Current URL: ${page.url()}`);

    if (!page.url().includes('/reports/product_mix')) {
        log.info(`Navigating to report URL: ${url}`);

        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });
    }
}

async function selectEstablishment(page) {
    const establishmentText = page.locator(
        '[data-cy="header-establishment-text"]',
    );

    await establishmentText.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    const currentEstablishment =
        (await establishmentText.textContent())?.trim()
        || 'Unknown';

    log.info(
        `Current establishment before selection: `
        + `${currentEstablishment}`,
    );

    if (currentEstablishment !== TARGET_ESTABLISHMENT) {
        await establishmentText.click();

        log.info('Clicked the establishment name.');

        const leanderOption = page
            .locator('span.fancytree-title')
            .filter({
                hasText: '42 | Leander',
            });

        await leanderOption.waitFor({
            state: 'visible',
            timeout: 30_000,
        });

        log.info('Establishment panel opened.');

        await saveScreenshot(page, 'REVEL_ESTABLISHMENT_LIST');

        log.info(`Selecting establishment: ${TARGET_ESTABLISHMENT}`);

        await leanderOption.click();
    }

    const selectedHeader = page
        .locator('[data-cy="header-establishment-text"]')
        .filter({
            hasText: /^\s*Leander\s*$/,
        });

    await selectedHeader.waitFor({
        state: 'visible',
        timeout: 30_000,
    });

    const selectedEstablishment =
        (await selectedHeader.textContent())?.trim();

    if (selectedEstablishment !== TARGET_ESTABLISHMENT) {
        throw new Error(
            `Expected establishment "${TARGET_ESTABLISHMENT}", `
            + `but found "${selectedEstablishment}".`,
        );
    }

    log.info(
        `Establishment selected successfully: `
        + `${selectedEstablishment}`,
    );

    return selectedEstablishment;
}

async function setDateRange(page, range) {
    const dateRangeDropdown = page.locator(
        '.report-date-row .ico-f-to-down',
    );

    await dateRangeDropdown.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    log.info('Opening the Product Mix date-range dropdown.');

    await dateRangeDropdown.click();

    const visibleDatePicker = page.locator('.daterangepicker:visible');

    await visibleDatePicker.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    await saveScreenshot(page, 'REVEL_DATE_RANGE_OPEN');

    log.info(
        `Setting internal report range: `
        + `${range.startDate} ${range.startTime} `
        + `${range.startMeridiem} through `
        + `${range.endDate} ${range.endTime} `
        + `${range.endMeridiem}.`,
    );

    const pickerResult = await page.evaluate(
        ({
            startDateValue,
            startTimeValue,
            startMeridiemValue,
            endDateValue,
            endTimeValue,
            endMeridiemValue,
        }) => {
            const $ = window.jQuery;
            const moment = window.moment;

            if (!$) {
                throw new Error('jQuery is not available on the page.');
            }

            if (!moment) {
                throw new Error('Moment.js is not available on the page.');
            }

            const candidates = $('*').filter(function findPicker() {
                return Boolean($(this).data('daterangepicker'));
            });

            if (candidates.length === 0) {
                throw new Error(
                    'Unable to locate Revel daterangepicker instance.',
                );
            }

            let picker = null;

            candidates.each(function selectVisiblePicker() {
                const candidate = $(this).data('daterangepicker');

                if (
                    !picker
                    && candidate?.container
                    && candidate.container.is(':visible')
                ) {
                    picker = candidate;
                }
            });

            if (!picker) {
                picker = $(candidates[0]).data('daterangepicker');
            }

            const startDateTime = moment(
                `${startDateValue} ${startTimeValue} ${startMeridiemValue}`,
                'MM/DD/YYYY hh:mm A',
                true,
            );

            const endDateTime = moment(
                `${endDateValue} ${endTimeValue} ${endMeridiemValue}`,
                'MM/DD/YYYY hh:mm A',
                true,
            );

            if (!startDateTime.isValid()) {
                throw new Error('The requested start date/time is invalid.');
            }

            if (!endDateTime.isValid()) {
                throw new Error('The requested end date/time is invalid.');
            }

            if (endDateTime.isBefore(startDateTime)) {
                throw new Error(
                    'The report end date/time cannot be '
                    + 'before the start date/time.',
                );
            }

            if (
                typeof picker.setStartDate !== 'function'
                || typeof picker.setEndDate !== 'function'
                || typeof picker.clickApply !== 'function'
            ) {
                throw new Error(
                    'The Revel daterangepicker does not expose its '
                    + 'date-setting or Apply methods.',
                );
            }

            picker.setStartDate(startDateTime);
            picker.setEndDate(endDateTime);

            if (typeof picker.updateView === 'function') {
                picker.updateView();
            }

            if (typeof picker.updateCalendars === 'function') {
                picker.updateCalendars();
            }

            if (typeof picker.updateFormInputs === 'function') {
                picker.updateFormInputs();
            }

            const result = {
                startDate: picker.startDate.format('MM/DD/YYYY hh:mm A'),
                endDate: picker.endDate.format('MM/DD/YYYY hh:mm A'),
            };

            picker.clickApply();

            return result;
        },
        {
            startDateValue: range.startDate,
            startTimeValue: range.startTime,
            startMeridiemValue: range.startMeridiem,
            endDateValue: range.endDate,
            endTimeValue: range.endTime,
            endMeridiemValue: range.endMeridiem,
        },
    );

    log.info(
        `Applied picker range: ${pickerResult.startDate} through `
        + `${pickerResult.endDate}`,
    );

    await visibleDatePicker.waitFor({
        state: 'hidden',
        timeout: 30_000,
    });

    /*
     * Revel updates the date label before/while it asynchronously
     * rebuilds the report, so wait for the label to match and then
     * for the loaders to disappear.
     */
    await page.waitForFunction(
        ({ expectedStartDate, expectedEndDate }) => {
            const normalizeDate = (value) => {
                const match = String(value).match(
                    /(\d{1,2})\/(\d{1,2})\/(\d{4})/,
                );

                if (!match) return null;

                const [, month, day, year] = match;

                return `${month.padStart(2, '0')}/`
                    + `${day.padStart(2, '0')}/${year}`;
            };

            const reportDateRow = document.querySelector(
                '.report-date-row',
            );

            if (!reportDateRow) return false;

            const displayedDates = (reportDateRow.textContent ?? '')
                .match(/\d{1,2}\/\d{1,2}\/\d{4}/g)
                ?.map(normalizeDate);

            if (!displayedDates || displayedDates.length < 2) {
                return false;
            }

            return (
                displayedDates[0] === normalizeDate(expectedStartDate)
                && displayedDates[1] === normalizeDate(expectedEndDate)
            );
        },
        {
            expectedStartDate: range.startDate,
            expectedEndDate: range.endDate,
        },
        {
            timeout: 90_000,
            polling: 500,
        },
    );

    const displayedRange = (
        await page.locator('.report-date-row').first().innerText()
    ).replace(/\s+/g, ' ').trim();

    log.info(`Revel displays the requested report range: ${displayedRange}`);

    await waitForReportIdle(page);

    await saveScreenshot(page, 'REVEL_DATE_RANGE_APPLIED');
}

/**
 * A click that lands while another panel is still closing can leave
 * the toggle marked active with its form hidden; the next click resets
 * it, so keep clicking until the form shows.
 */
async function openPanel(page, panel) {
    const form = page.locator(panel.form);
    const toggle = page.locator(panel.toggle).first();
    const maxAttempts = 4;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (await form.isVisible()) return form;

        log.info(
            `Opening the ${panel.name} panel `
            + `(attempt ${attempt} of ${maxAttempts}).`,
        );

        await toggle.click();

        if (await pollUntil(() => form.isVisible(), 5_000)) return form;
    }

    throw new Error(
        `The ${panel.name} panel did not open after ${maxAttempts} clicks.`,
    );
}

async function closePanel(page, panel) {
    const form = page.locator(panel.form);

    /*
     * Apply/Save may close the panel on their own with an animation;
     * clicking the toggle mid-animation would reopen it.
     */
    const closedOnItsOwn = await pollUntil(
        async () => !(await form.isVisible()),
        3_000,
    );

    if (closedOnItsOwn) return;

    await page.locator(panel.toggle).first().click();

    await form.waitFor({
        state: 'hidden',
        timeout: 15_000,
    });
}

/**
 * Employees, POS Station and Dining Options: pick "All (Default)".
 */
async function selectAllInEveryRadioGroup(form) {
    const groupNames = await form
        .locator('input[type="radio"]')
        .evaluateAll((radios) => [
            ...new Set(radios.map((radio) => radio.name).filter(Boolean)),
        ]);

    for (const name of groupNames) {
        const radios = await form
            .locator(`input[type="radio"][name="${name}"]`)
            .all();

        let allRadio = null;

        for (const radio of radios) {
            if (/^All\b/i.test(await describeInput(radio))) {
                allRadio = radio;
                break;
            }
        }

        if (!allRadio || !(await isInteractive(allRadio))) {
            log.warning(
                `Filter group "${name}" has no visible "All" option; `
                + 'leaving it unchanged.',
            );
            continue;
        }

        await setInputChecked(allRadio, true, `Filter ${name}: All`);
    }
}

/**
 * Day of the Week and Inclusions (Open, Unpaid, Irregular,
 * Web Orders Only, Mod. Mix): nothing checked.
 */
async function clearFilterCheckboxes(form) {
    const checkboxes = await form.locator('input[type="checkbox"]').all();

    for (const checkbox of checkboxes) {
        const insideTree = await checkbox.evaluate(
            (element) => Boolean(element.closest('.fancytree-container')),
        );

        if (insideTree || !(await isInteractive(checkbox))) continue;

        await setInputChecked(
            checkbox,
            false,
            `Filter: ${await describeInput(checkbox)}`,
        );
    }
}

/**
 * Product Category is a fancytree; only the "All" node may be selected.
 */
async function selectOnlyAllProductCategory(page, form) {
    const allTitle = page.locator('span.fancytree-title', {
        hasText: /^\s*All\s*$/,
    });

    const allNode = form
        .locator('span.fancytree-node')
        .filter({ has: allTitle })
        .first();

    const otherSelectedNodes = form
        .locator(
            'span.fancytree-node.fancytree-selected, '
            + 'span.fancytree-node.fancytree-partsel',
        )
        .filter({ hasNot: allTitle });

    await allNode.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    /*
     * Clicking a partially selected parent selects it fully, so a
     * parent can take two passes before it is cleared.
     */
    for (
        let attempt = 0;
        attempt < 100 && await otherSelectedNodes.count() > 0;
        attempt += 1
    ) {
        const node = otherSelectedNodes.first();
        const title = (
            await node.locator('span.fancytree-title').innerText()
        ).trim();

        log.info(`Clearing product category selection: ${title}`);

        await node.locator('span.fancytree-checkbox').click();
    }

    if (!(await hasClass(allNode, 'fancytree-selected'))) {
        await allNode.locator('span.fancytree-checkbox').click();

        const selected = await pollUntil(
            () => hasClass(allNode, 'fancytree-selected'),
            5_000,
        );

        if (!selected) {
            throw new Error('Unable to select Product Category "All".');
        }

        log.info('Selected: Product Category All');
    }

    const remaining = await otherSelectedNodes
        .locator('span.fancytree-title')
        .allInnerTexts();

    if (remaining.length > 0) {
        throw new Error(
            'Product categories other than "All" are still selected: '
            + `${remaining.join(', ')}`,
        );
    }
}

async function applyFilters(page) {
    const form = await openPanel(page, PANELS.filters);

    await saveScreenshot(page, 'REVEL_FILTERS_OPEN');

    await selectAllInEveryRadioGroup(form);
    await clearFilterCheckboxes(form);
    await selectOnlyAllProductCategory(page, form);

    await saveScreenshot(page, 'REVEL_FILTERS_SELECTED');

    const applyButton = page
        .locator('.filters-area')
        .getByRole('button', { name: 'Apply', exact: true })
        .or(page.locator('.filters-area .button', {
            hasText: /^\s*Apply\s*$/,
        }))
        .first();

    await applyButton.waitFor({
        state: 'visible',
        timeout: 15_000,
    });

    if (await isButtonDisabled(applyButton)) {
        log.info('Filters already match the required selections.');
    } else {
        log.info('Applying filters.');

        await applyButton.click();
        await page.waitForTimeout(1_000);
        await waitForReportIdle(page);
    }

    await closePanel(page, PANELS.filters);

    await saveScreenshot(page, 'REVEL_FILTERS_APPLIED');
}

async function applyPreferences(page) {
    const form = await openPanel(page, PANELS.preferences);

    await saveScreenshot(page, 'REVEL_PREFERENCES_OPEN');

    /*
     * Radios first: Sort by Category disables and forces some of the
     * "Fields to Display" checkboxes.
     */
    for (const { id, label } of PREFERENCE_RADIOS) {
        await setInputChecked(
            form.locator(`#${id}`),
            true,
            `Preference: ${label}`,
        );
    }

    for (const { id, label } of PREFERENCE_CHECKBOXES) {
        await setInputChecked(
            form.locator(`#${id}`),
            true,
            `Preference: ${label}`,
        );
    }

    const requiredIds = new Set(PREFERENCE_CHECKBOXES.map(({ id }) => id));
    const checkboxes = await form.locator('input[type="checkbox"]').all();

    for (const checkbox of checkboxes) {
        const id = await checkbox.getAttribute('id');

        if (
            requiredIds.has(id)
            || await isLocked(checkbox)
            || !(await isInteractive(checkbox))
        ) {
            continue;
        }

        const description = `Preference: ${await describeInput(checkbox)}`;

        try {
            await setInputChecked(checkbox, false, description);
        } catch (error) {
            /*
             * Revel re-checks some fields that the chosen sort order
             * requires (e.g. Category under Sort by Category).
             */
            if (!(await checkbox.isChecked())) throw error;

            log.warning(
                `Revel keeps "${description}" checked; leaving it as is.`,
            );
        }
    }

    for (const { id, label } of [
        ...PREFERENCE_RADIOS,
        ...PREFERENCE_CHECKBOXES,
    ]) {
        if (!(await form.locator(`#${id}`).isChecked())) {
            throw new Error(`Preference "${label}" is not selected.`);
        }
    }

    await saveScreenshot(page, 'REVEL_PREFERENCES_SELECTED');

    const saveButton = form.locator('#detail_save');

    if (await isButtonDisabled(saveButton)) {
        log.info('Preferences already match the required selections.');
    } else {
        log.info('Saving preferences.');

        await saveButton.click();
        await page.waitForTimeout(1_000);
        await waitForReportIdle(page);
    }

    await closePanel(page, PANELS.preferences);

    await saveScreenshot(page, 'REVEL_PREFERENCES_APPLIED');
}

/**
 * Click the JSON option in the report's "..." export menu and return
 * the exported text. Revel may deliver it as a file download or open
 * it in a new tab, so both are handled.
 */
async function exportJsonReport(page) {
    const exportMenuButton = page
        .locator('.header-more .button-more:visible')
        .first();

    await exportMenuButton.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    log.info('Opening the report export menu.');

    await exportMenuButton.click();

    const jsonExportLink = page
        .locator('[data-exporttype="json"]:visible')
        .or(page.locator('.header-more').getByText(/^\s*JSON\s*$/i))
        .first();

    await jsonExportLink.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    const exportTypes = await page
        .locator('[data-exporttype]:visible')
        .evaluateAll((links) => links.map((link) => link.dataset.exporttype));

    log.info(`Available export types: ${exportTypes.join(', ')}`);

    await saveScreenshot(page, 'REVEL_EXPORT_MENU_OPEN');

    log.info('Exporting the Product Mix report as JSON.');

    const exportResult = Promise.race([
        page.waitForEvent('download', { timeout: 90_000 })
            .then((download) => ({ download })),
        page.context().waitForEvent('page', { timeout: 90_000 })
            .then((popup) => ({ popup })),
    ]);

    await jsonExportLink.click();

    const { download, popup } = await exportResult;

    if (popup) {
        await popup.waitForLoadState('domcontentloaded');

        const text = await popup.evaluate(
            () => document.body?.innerText ?? '',
        );
        const filename = new URL(popup.url()).pathname
            .split('/')
            .pop() || 'product_mix.json';

        await popup.close();

        return { text, filename };
    }

    const downloadFailure = await download.failure();

    if (downloadFailure) {
        throw new Error(`JSON download failed: ${downloadFailure}`);
    }

    const temporaryFilePath = await download.path();

    if (!temporaryFilePath) {
        throw new Error(
            'Playwright did not provide a path for the downloaded file.',
        );
    }

    return {
        text: await readFile(temporaryFilePath, 'utf8'),
        filename: download.suggestedFilename(),
    };
}

function isPlainObject(value) {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value);
}

/**
 * Breadth-first search so the shallowest occurrence of the key wins.
 */
function findKeyValue(document, key) {
    const queue = [{ value: document, path: '$' }];

    while (queue.length > 0) {
        const { value, path } = queue.shift();

        if (isPlainObject(value)) {
            if (Object.hasOwn(value, key)) {
                return { path: `${path}.${key}`, value: value[key] };
            }

            for (const [childKey, child] of Object.entries(value)) {
                queue.push({ value: child, path: `${path}.${childKey}` });
            }
        } else if (Array.isArray(value)) {
            value.forEach((child, index) => {
                queue.push({ value: child, path: `${path}[${index}]` });
            });
        }
    }

    return null;
}

function toRowList(value, path) {
    if (Array.isArray(value)) return value.filter(isPlainObject);

    if (isPlainObject(value) && Object.values(value).every(isPlainObject)) {
        return Object.values(value);
    }

    throw new Error(
        `Expected ${path} to be a list of rows, but found `
        + `${Array.isArray(value) ? 'an array' : typeof value}.`,
    );
}

function compositeKey(record, primaryKeyFields) {
    const keyText = primaryKeyFields
        .map((field) => String(record[field] ?? ''))
        .join('|');

    return createHash('sha256').update(keyText).digest('hex');
}

/**
 * The rows under extract.key, filtered by extract.keepRow, reduced to
 * extract.fields and keyed by a hash of extract.primaryKeyFields.
 */
function buildExtractRows(reportJson, extract, { businessDate, location }) {
    const { key, fields, primaryKeyFields, keepRow } = extract;
    const match = findKeyValue(reportJson, key);

    if (!match) {
        throw new Error(
            `"${key}" was not found in the Product Mix JSON `
            + 'export. See PRODUCT_MIX_RAW in the key-value store.',
        );
    }

    const sourceRows = toRowList(match.value, match.path);

    const missingFields = fields.filter(
        (field) => !sourceRows.some((row) => Object.hasOwn(row, field)),
    );

    if (sourceRows.length > 0 && missingFields.length > 0) {
        log.warning(
            `These fields never appear in ${match.path}: `
            + `${missingFields.join(', ')}`,
        );
    }

    const rows = sourceRows
        .filter(keepRow)
        .map((row) => {
            const record = {
                business_date: businessDate,
                location,
                ...Object.fromEntries(
                    fields.map((field) => [field, row[field] ?? null]),
                ),
            };

            return { id: compositeKey(record, primaryKeyFields), ...record };
        });

    /*
     * Postgres rejects an upsert batch that touches the same key twice,
     * and silently merging rows would misstate quantities.
     */
    const seen = new Map();
    const duplicates = [];

    for (const row of rows) {
        if (seen.has(row.id)) {
            duplicates.push(
                primaryKeyFields.map((field) => row[field]).join(' | '),
            );
        }

        seen.set(row.id, row);
    }

    if (duplicates.length > 0) {
        throw new Error(
            `${duplicates.length} ${key} rows share a primary key `
            + `with another row, e.g. ${duplicates.slice(0, 5).join('; ')}`,
        );
    }

    return {
        path: match.path,
        sourceRowCount: sourceRows.length,
        rows,
    };
}

async function upsertToSupabase(table, rows) {
    for (let start = 0; start < rows.length; start += SUPABASE_BATCH_SIZE) {
        const batch = rows.slice(start, start + SUPABASE_BATCH_SIZE);

        const { error } = await supabase
            .from(table)
            .upsert(batch, { onConflict: 'id' });

        if (error) {
            throw new Error(
                `Unable to write Product Mix rows to Supabase table `
                + `"${table}": ${error.message}`,
            );
        }
    }
}

let exitCode = 0;
let statusMessage;

try {
    log.info('Reading Actor input.');

    const input = await Actor.getInput();

    const {
        url = 'https://laynes.revelup.com/reports/product_mix/',
        username,
        password,
        establishment = TARGET_ESTABLISHMENT,
        override_flag = false,
        override_date,
        supabaseTable = 'daily-product-mix-combomix',
        productMixTable = 'daily-product-mix-productmix',
    } = input ?? {};

    const extracts = [
        { ...PRODUCT_COMBOS_EXTRACT, table: supabaseTable },
        { ...PRODUCT_MIX_EXTRACT, table: productMixTable },
    ];

    if (override_flag && !override_date) {
        throw new Error(
            'override_date is required when override_flag is true.',
        );
    }

    const requestedDate = override_flag
        ? override_date.trim()
        : calculateReportDate();

    log.info('Actor input loaded.', {
        hasUsername: Boolean(username),
        hasPassword: Boolean(password),
        establishment,
        override_flag,
        reportDate: requestedDate,
    });

    if (!username || !password) {
        throw new Error('Both username and password are required.');
    }

    if (establishment !== TARGET_ESTABLISHMENT) {
        throw new Error(
            `The current Actor version only supports Leander. `
            + `Received: ${establishment}`,
        );
    }

    validateDate(requestedDate, 'Report date');

    const reportDate = normalizeDate(requestedDate);

    const range = {
        startDate: reportDate,
        startTime: REPORT_START_TIME.time,
        startMeridiem: REPORT_START_TIME.meridiem,
        endDate: reportDate,
        endTime: REPORT_END_TIME.time,
        endMeridiem: REPORT_END_TIME.meridiem,
    };

    let extractionError;

    const crawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: 1,
        maxRequestRetries: 0,
        requestHandlerTimeoutSecs: 480,

        async requestHandler({ page }) {
            await login(page, { url, username, password });

            const selectedEstablishment = await selectEstablishment(page);

            await page.locator(PANELS.filters.toggle).first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            await saveScreenshot(page, 'REVEL_LEANDER_PRODUCT_MIX');

            await setDateRange(page, range);
            await applyFilters(page);
            await applyPreferences(page);

            const { text, filename } = await exportJsonReport(page);

            await Actor.setValue('PRODUCT_MIX_RAW', text, {
                contentType: 'application/json',
            });

            let reportJson;

            try {
                reportJson = JSON.parse(text);
            } catch (parseError) {
                throw new Error(
                    'The Product Mix JSON export is not valid JSON: '
                    + `${parseError.message}`,
                );
            }

            const businessDate = toIsoDate(reportDate);
            const extractedAt = new Date().toISOString();

            const metadata = {
                report: REPORT_NAME,
                establishment: selectedEstablishment,
                business_date: businessDate,
                start_time: `${range.startTime} ${range.startMeridiem}`,
                end_time: `${range.endTime} ${range.endMeridiem}`,
                source_filename: filename,
                extracted_at: extractedAt,
            };

            await Actor.setValue('PRODUCT_MIX_JSON', {
                ...metadata,
                report_data: reportJson,
            });

            /*
             * Build every extract before writing any, so a problem with
             * one key does not leave the other table half-updated.
             */
            const results = extracts.map((extract) => {
                const result = buildExtractRows(reportJson, extract, {
                    businessDate,
                    location: selectedEstablishment,
                });

                log.info(
                    `${extract.key}: found ${result.sourceRowCount} rows at `
                    + `${result.path}; ${result.rows.length} remain after `
                    + `${extract.filterDescription}.`,
                );

                if (result.rows.length === 0) {
                    throw new Error(
                        `No ${extract.key} rows remain after `
                        + `${extract.filterDescription}.`,
                    );
                }

                return { extract, ...result };
            });

            for (const { extract, rows } of results) {
                await Actor.setValue(
                    `${extract.key.toUpperCase()}_ROWS`,
                    rows,
                );

                await Actor.pushData(
                    rows.map((row) => ({ source: extract.key, ...row })),
                );

                await upsertToSupabase(extract.table, rows);

                log.info(
                    `${extract.key}: upserted ${rows.length} rows into `
                    + `Supabase table "${extract.table}".`,
                );
            }

            await Actor.setValue('OUTPUT', {
                status: 'success',
                ...metadata,
                extracts: Object.fromEntries(
                    results.map(({ extract, path, sourceRowCount, rows }) => [
                        extract.key,
                        {
                            rows_path: path,
                            source_rows: sourceRowCount,
                            saved_rows: rows.length,
                            supabase_table: extract.table,
                        },
                    ]),
                ),
            });
        },

        async failedRequestHandler({ page }, error) {
            extractionError = error;

            log.error(`Revel extraction failed: ${error.message}`);

            if (page) {
                try {
                    await saveScreenshot(page, 'REVEL_EXTRACTION_FAILURE');
                } catch (screenshotError) {
                    log.warning(
                        `Unable to save failure screenshot: `
                        + `${screenshotError.message}`,
                    );
                }
            }
        },
    });

    await crawler.run([url]);

    if (extractionError) throw extractionError;
} catch (error) {
    const failure = error instanceof Error
        ? error
        : new Error(String(error));

    exitCode = 1;
    statusMessage = failure.message;
    log.exception(failure, failure.message);

    await Actor.setValue('OUTPUT', {
        status: 'failed',
        report: REPORT_NAME,
        message: failure.message,
        timestamp: new Date().toISOString(),
    });
} finally {
    await Actor.exit({
        exitCode,
        ...(statusMessage ? { statusMessage } : {}),
    });
}
