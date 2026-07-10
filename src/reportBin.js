const { chromium } = require('playwright');

const FORM_URL = 'https://my.barnsley.gov.uk/form/report-a-missed-bin/missed-bin-details';
const BIN_COLOURS = ['Blue', 'Brown', 'Green', 'Grey'];

function todayIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function fillAddress(page, { houseNumber, postcode, uprn }) {
  await page.fill('#Fields_7__Data_3__Value', houseNumber);
  await page.fill('#Fields_7__Data_4__Value', postcode);
  await page.click('#address-lookup');
  await page.waitForTimeout(1200);

  const select = page.locator('select[name="Fields\\[7\\]\\.Data\\[0\\]\\.Value"]');
  if (await select.count()) {
    const options = await select.locator('option').evaluateAll((els) =>
      els.map((e) => ({ value: e.value, label: e.textContent.trim() })).filter((o) => o.value !== 'select_address')
    );

    if (uprn) {
      const match = options.find((o) => o.value === uprn);
      if (!match) {
        throw new Error(`UPRN ${uprn} was not among the address matches: ${JSON.stringify(options)}`);
      }
      await select.selectOption(uprn);
    } else if (options.length === 1) {
      await select.selectOption(options[0].value);
    } else {
      const err = new Error('AMBIGUOUS_ADDRESS');
      err.options = options;
      throw err;
    }

    await page.click('button[name="action"][value="address-lookup"]');
    await page.waitForTimeout(1200);
  }
}

async function listAddresses({ houseNumber, postcode }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(FORM_URL, { waitUntil: 'networkidle' });
    await page.fill('#Fields_7__Data_3__Value', houseNumber);
    await page.fill('#Fields_7__Data_4__Value', postcode);
    await page.click('#address-lookup');
    await page.waitForTimeout(1200);

    const select = page.locator('select[name="Fields\\[7\\]\\.Data\\[0\\]\\.Value"]');
    if (await select.count()) {
      const options = await select.locator('option').evaluateAll((els) =>
        els.map((e) => ({ uprn: e.value, address: e.textContent.trim() })).filter((o) => o.uprn !== 'select_address')
      );
      return { matched: false, addresses: options };
    }

    const singleAddress = await page.locator('p.address').textContent().catch(() => null);
    const uprnInput = await page.locator('input#Fields_7__Data_0__Value[type=hidden]').getAttribute('value').catch(() => null);
    if (singleAddress) {
      return { matched: true, addresses: [{ uprn: uprnInput, address: singleAddress.trim() }] };
    }

    return { matched: false, addresses: [] };
  } finally {
    await browser.close();
  }
}

async function reportMissedBin({ houseNumber, postcode, uprn, colour, everyoneAffected = true, dryRun = false }) {
  if (!BIN_COLOURS.includes(colour)) {
    throw new Error(`colour must be one of ${BIN_COLOURS.join(', ')}`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(FORM_URL, { waitUntil: 'networkidle' });

    await fillAddress(page, { houseNumber, postcode, uprn });

    // Page: address confirmed -> Continue
    await page.click('button[name="action"][value="submit"]');
    await page.waitForTimeout(1200);

    // Page: informational "Collection date" notice (only shown when the address is on a round) -> Continue
    const stopNotice = await page.locator('.outline--message.outline--error').textContent().catch(() => null);
    if (stopNotice) {
      throw new Error(`Council form refused this address: ${stopNotice.trim()}`);
    }
    const infoHeading = await page.locator('h3').filter({ hasText: 'Collection date' }).count();
    if (infoHeading) {
      await page.click('button[name="action"][value="submit"]');
      await page.waitForTimeout(1200);
    }

    // Page: date / colour / whole-street details
    await page.fill('#Fields_1__Data_0__Value', todayIso());
    await page.selectOption('#Fields_2__Data_0__Value', colour);
    await page.check(
      `input[name="Fields[3].Data[0].Value"][value="${everyoneAffected ? 'Whole street' : 'Just my bin'}"]`
    );
    await page.click('button[name="action"][value="submit"]');
    await page.waitForTimeout(1200);

    const rawSummary = (await page.locator('.summary-list').allTextContents()).join('\n');
    const summary = rawSummary
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');

    if (dryRun) {
      return { submitted: false, summary };
    }

    await page.click('button[name="action"][value="submit"]');
    await page.waitForTimeout(1500);

    const confirmation = await page.evaluate(() => document.body.innerText);
    return {
      submitted: true,
      summary,
      confirmation: confirmation.trim(),
    };
  } finally {
    await browser.close();
  }
}

module.exports = { reportMissedBin, listAddresses, BIN_COLOURS };
