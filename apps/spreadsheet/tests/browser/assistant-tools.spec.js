import { test, expect } from '@playwright/test';
import { installGatewayMock } from './gateway-mock.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const ALL_TOOLS = 22;

function cell(page, r, c) {
    return page.locator(`#gc-${r}-${c}`);
}

async function openAssistant(page) {
    const message = page.getByRole('textbox', { name: 'Message the assistant' });
    if (!(await message.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'Expand the assistant' }).click();
    }
    await expect(page.getByRole('heading', { name: 'Assistant' })).toBeVisible();
    return message;
}

async function start(page, script) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const mock = await installGatewayMock(page, script);
    await page.goto('/');
    await expect(page.getByRole('grid', { name: 'Spreadsheet grid' })).toBeVisible();
    await openAssistant(page);
    return { errors, mock };
}

async function seedSales(page) {
    const grid = page.getByRole('grid', { name: 'Spreadsheet grid' });
    await grid.click();
    await page.keyboard.press(`${MOD}+Home`);
    await page.keyboard.type('Region');
    await page.keyboard.press('Enter');
    await page.keyboard.type('North');
    await page.keyboard.press('Enter');
    await page.keyboard.type('South');
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+Home`);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('Amount');
    await page.keyboard.press('Enter');
    await page.keyboard.type('10');
    await page.keyboard.press('Enter');
    await page.keyboard.type('20');
    await page.keyboard.press('Enter');
    await expect(cell(page, 0, 0)).toHaveText('Region');
    await expect(cell(page, 1, 0)).toHaveText('North');
    await expect(cell(page, 0, 1)).toHaveText('Amount');
    await expect(cell(page, 2, 1)).toHaveText('20');
}

async function ask(page, prompt, label, { approve = false } = {}) {
    const box = page.getByRole('textbox', { name: 'Message the assistant' });
    await box.fill(prompt);
    await box.press('Enter');
    const reply = page.locator('.ai-msg.ai-assistant').last();
    const step = reply.locator('.ai-step').filter({ hasText: label }).first();
    await expect(step).toBeVisible();
    if (approve) {
        await step.getByRole('button', { name: 'Allow', exact: true }).click();
    }
    await expect(step).toHaveClass(/ai-step-done/);
    await expect(reply).not.toHaveAttribute('aria-busy', 'true');
    return { reply, step };
}

test('drives the reading tools through the assistant panel', async ({ page }) => {
    const { errors, mock } = await start(page, [
        { prompt: 'Summarize this workbook', tool: { name: 'get_workbook_info', arguments: {} }, reply: 'The workbook has one sheet, Sheet1.' },
        { prompt: 'Read the sales table', tool: { name: 'read_range', arguments: { range: 'A1:B3' } }, reply: 'Region and its amounts are in A1:B3.' },
        { prompt: 'Calculate the total amount', tool: { name: 'calculate', arguments: { formula: '=SUM(B2:B3)' } }, reply: 'The total amount is 30.' },
        { prompt: 'Find North in the sheet', tool: { name: 'find', arguments: { query: 'North' } }, reply: 'North is in A2.' },
        { prompt: 'Select the sales table', tool: { name: 'select_range', arguments: { range: 'A1:B3' } }, reply: 'Selected A1:B3.' },
    ]);
    await seedSales(page);

    const info = await ask(page, 'Summarize this workbook', 'Look over the workbook');
    await expect(info.reply.locator('.ai-text').last()).toContainText('one sheet');

    await ask(page, 'Read the sales table', 'Read Sheet1!A1:B3');
    await ask(page, 'Calculate the total amount', 'Calculate =SUM(B2:B3)');
    await ask(page, 'Find North in the sheet', 'Search for “North”');
    const selected = await ask(page, 'Select the sales table', 'Select Sheet1!A1:B3');

    await expect(cell(page, 0, 0)).toHaveAttribute('aria-selected', 'true');
    await expect(cell(page, 2, 1)).toHaveAttribute('aria-selected', 'true');
    await expect(selected.reply.locator('.ai-text').last()).toContainText('Selected A1:B3');

    const first = mock.requests[0];
    expect(first.stream).toBe(true);
    expect(first.tools.map((tool) => tool.function.name)).toHaveLength(ALL_TOOLS);
    const afterTool = mock.requests[1];
    expect(afterTool.messages[afterTool.messages.length - 1].role).toBe('tool');
    expect(errors).toEqual([]);
});

test('drives the writing and formatting tools through the assistant panel', async ({ page }) => {
    const { errors } = await start(page, [
        {
            prompt: 'Write a small sales table',
            tool: { name: 'write_cells', arguments: { start_cell: 'A5', values: [['East', 30], ['West', 40]] } },
            reply: 'Wrote East and West with their amounts.',
        },
        { prompt: 'Fill the totals column', tool: { name: 'fill_formula', arguments: { range: 'C5:C6', formula: '=B5*2' } }, reply: 'Filled C5:C6.' },
        {
            prompt: 'Bold and highlight the header',
            tool: { name: 'format_cells', arguments: { range: 'A1:B1', bold: true, fill_color: '#fef3c7' } },
            reply: 'Formatted A1:B1.',
        },
        {
            prompt: 'Sort the sales by amount descending',
            tool: { name: 'sort_range', arguments: { range: 'A5:C6', keys: [{ column: 'B', ascending: false }], has_header: false } },
            reply: 'Sorted A5:C6 by amount, largest first.',
        },
        {
            prompt: 'Highlight amounts over 35',
            tool: { name: 'add_conditional_format', arguments: { range: 'B5:B6', rule: 'gt', value: '35', fill_color: '#ffcc00' } },
            reply: 'Highlighted amounts over 35.',
        },
        {
            prompt: 'Add a status dropdown',
            tool: { name: 'add_dropdown', arguments: { range: 'D5:D6', options: ['Open', 'Closed'] } },
            reply: 'Added a dropdown to D5:D6.',
        },
        { prompt: 'Add a note to A1', tool: { name: 'add_note', arguments: { cell: 'A1', text: 'Watch this region' } }, reply: 'Added the note.' },
        { prompt: 'Widen column B', tool: { name: 'set_column_width', arguments: { columns: 'B', width: 220 } }, reply: 'Column B is 220px wide.' },
        { prompt: 'Clear the totals column', tool: { name: 'clear_range', arguments: { range: 'C5:C6' } }, reply: 'Cleared C5:C6.' },
    ]);
    await seedSales(page);

    await ask(page, 'Write a small sales table', 'Write 4 cells to Sheet1!A5:B6');
    await expect(cell(page, 4, 0)).toHaveText('East');
    await expect(cell(page, 4, 1)).toHaveText('30');
    await expect(cell(page, 5, 0)).toHaveText('West');
    await expect(cell(page, 5, 1)).toHaveText('40');

    await ask(page, 'Fill the totals column', 'Fill Sheet1!C5:C6 with =B5*2');
    await expect(cell(page, 4, 2)).toHaveText('60');
    await expect(cell(page, 5, 2)).toHaveText('80');

    await ask(page, 'Bold and highlight the header', 'Format Sheet1!A1:B1');
    await expect(cell(page, 0, 0)).toHaveCSS('font-weight', '600');
    await expect(cell(page, 0, 0)).toHaveCSS('background-color', 'rgb(254, 243, 199)');

    await ask(page, 'Sort the sales by amount descending', 'Sort Sheet1!A5:C6');
    await expect(cell(page, 4, 0)).toHaveText('West');
    await expect(cell(page, 4, 1)).toHaveText('40');
    await expect(cell(page, 5, 0)).toHaveText('East');
    await expect(cell(page, 5, 1)).toHaveText('30');

    await ask(page, 'Highlight amounts over 35', 'Highlight Sheet1!B5:B6 (gt)');
    await expect(cell(page, 4, 1)).toHaveCSS('background-color', 'rgb(255, 204, 0)');

    await ask(page, 'Add a status dropdown', 'Add a dropdown to Sheet1!D5:D6');
    await expect(cell(page, 4, 3)).toHaveClass(/has-list/);
    await expect(cell(page, 5, 3)).toHaveClass(/has-list/);

    await ask(page, 'Add a note to A1', 'Add a note to Sheet1!A1');
    await expect(cell(page, 0, 0)).toHaveClass(/has-note/);

    await ask(page, 'Widen column B', 'Set column B to 220px');
    await expect(cell(page, 0, 1)).toHaveCSS('width', '220px');

    await ask(page, 'Clear the totals column', 'Clear Sheet1!C5:C6', { approve: true });
    await expect(cell(page, 4, 2)).toHaveText('');
    await expect(cell(page, 5, 2)).toHaveText('');

    expect(errors).toEqual([]);
});

test('drives the structural and sheet tools through the assistant panel', async ({ page }) => {
    const { errors } = await start(page, [
        { prompt: 'Freeze the top two rows', tool: { name: 'freeze_panes', arguments: { rows: 2 } }, reply: 'Froze the top two rows.' },
        { prompt: 'Unfreeze the panes', tool: { name: 'freeze_panes', arguments: { rows: 0 } }, reply: 'Unfroze the panes.' },
        { prompt: 'Insert a row above the second row', tool: { name: 'insert_rows', arguments: { before_row: 2, count: 1 } }, reply: 'Inserted a row.' },
        { prompt: 'Delete the empty second row', tool: { name: 'delete_rows', arguments: { start_row: 2, count: 1 } }, reply: 'Deleted the empty row.' },
        { prompt: 'Insert a column before B', tool: { name: 'insert_columns', arguments: { before_column: 'B', count: 1 } }, reply: 'Inserted a column.' },
        { prompt: 'Delete the empty column before C', tool: { name: 'delete_columns', arguments: { start_column: 'B', count: 1 } }, reply: 'Deleted the empty column.' },
        { prompt: 'Turn the sales table into a table', tool: { name: 'create_table', arguments: { range: 'A1:B3', name: 'Sales' } }, reply: 'Made A1:B3 a table named Sales.' },
        { prompt: 'Chart the sales table', tool: { name: 'create_chart', arguments: { data_range: 'A1:B3', type: 'column', title: 'Sales by region' } }, reply: 'Added the chart.' },
        { prompt: 'Add a sheet called Notes', tool: { name: 'manage_sheet', arguments: { action: 'add', sheet: 'Notes' } }, reply: 'Added the sheet.' },
        { prompt: 'Rename Notes to Archive', tool: { name: 'manage_sheet', arguments: { action: 'rename', sheet: 'Notes', new_name: 'Archive' } }, reply: 'Renamed the sheet.' },
        { prompt: 'Show the Archive sheet', tool: { name: 'manage_sheet', arguments: { action: 'activate', sheet: 'Archive' } }, reply: 'Showing Archive.' },
        { prompt: 'Duplicate the Archive sheet', tool: { name: 'manage_sheet', arguments: { action: 'duplicate', sheet: 'Archive' } }, reply: 'Duplicated the sheet.' },
        { prompt: 'Delete the Archive copy', tool: { name: 'manage_sheet', arguments: { action: 'delete', sheet: 'Archive (copy)' } }, reply: 'Deleted the copy.' },
    ]);
    await seedSales(page);

    await ask(page, 'Freeze the top two rows', 'Freeze 2 rows on Sheet1');
    await expect(page.locator('.frz-rows')).toBeVisible();
    await ask(page, 'Unfreeze the panes', 'Unfreeze Sheet1');
    await expect(page.locator('.frz-rows')).toBeHidden();

    await ask(page, 'Insert a row above the second row', 'Insert 1 row above row 2 on Sheet1');
    await expect(cell(page, 1, 0)).toHaveText('');
    await expect(cell(page, 2, 0)).toHaveText('North');

    await ask(page, 'Delete the empty second row', 'Delete row 2 on Sheet1');
    await expect(cell(page, 1, 0)).toHaveText('North');

    await ask(page, 'Insert a column before B', 'Insert 1 column left of B on Sheet1');
    await expect(cell(page, 0, 1)).toHaveText('');
    await expect(cell(page, 0, 2)).toHaveText('Amount');

    await ask(page, 'Delete the empty column before C', 'Delete column B on Sheet1');
    await expect(cell(page, 0, 1)).toHaveText('Amount');
    await expect(cell(page, 0, 2)).toHaveText('');

    await ask(page, 'Turn the sales table into a table', 'Make Sheet1!A1:B3 a table');
    await expect(page.locator('.table-handle').first()).toBeVisible();
    await expect(page.locator('.cell.filter-head')).toHaveCount(2);

    await ask(page, 'Chart the sales table', 'Add a column chart of Sheet1!A1:B3');
    await expect(page.locator('.chart-box').first()).toBeVisible();
    await expect(page.locator('.chart-box svg').first()).toContainText('Sales by region');

    await ask(page, 'Add a sheet called Notes', 'Add a sheet named Notes');
    await expect(page.getByRole('tab', { name: 'Notes', exact: true })).toBeVisible();

    await ask(page, 'Rename Notes to Archive', 'Rename Notes to Archive');
    await expect(page.getByRole('tab', { name: 'Archive', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Notes', exact: true })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Sheet1', exact: true }).click();
    await ask(page, 'Show the Archive sheet', 'Show Archive');
    await expect(page.getByRole('tab', { name: 'Archive', exact: true })).toHaveAttribute('aria-selected', 'true');

    await ask(page, 'Duplicate the Archive sheet', 'Duplicate Archive');
    await expect(page.getByRole('tab', { name: 'Archive (copy)', exact: true })).toBeVisible();

    await ask(page, 'Delete the Archive copy', 'Delete the sheet Archive (copy)', { approve: true });
    await expect(page.getByRole('tab', { name: 'Archive (copy)', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Archive', exact: true })).toHaveCount(1);

    expect(errors).toEqual([]);
});
