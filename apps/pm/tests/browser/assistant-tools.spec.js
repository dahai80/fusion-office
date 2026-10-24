import { test, expect } from '@playwright/test';
import { askAssistant, mockGateway, openAssistant } from './gateway-mock.js';

test.skip(!process.env.VITE_FUSION_GATEWAY_KEY,
    'Set VITE_FUSION_GATEWAY_KEY so the assistant is configured in the built page.');

const PROJECT = 'Assistant tools';

function column(page, name) {
    return page.locator('.board .col').filter({
        has: page.getByRole('heading', { name, exact: true }),
    });
}

function card(page, title) {
    return page.locator('.board .card').filter({ hasText: title });
}

function step(dialog, label) {
    return dialog.locator('.pm-as-step').filter({ hasText: label });
}

async function startProject(page, name = PROJECT) {
    await page.goto('/');
    await expect(page.getByText('Could not start the local workspace')).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toBeVisible();
    const onboarding = page.getByRole('heading', { name: 'Welcome' });
    if (await onboarding.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: 'Skip for now' }).click();
        await expect(onboarding).toHaveCount(0);
    }
    await nav.getByRole('button', { name: 'New project' }).click();
    await expect(page.getByRole('heading', { name: 'New project' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function addTask(page, columnName, title) {
    const col = column(page, columnName);
    await col.getByRole('button', { name: 'Add task', exact: true }).click();
    const input = col.locator('.composer-input');
    await input.fill(title);
    await input.press('Enter');
    await expect(col.locator('.card-title', { hasText: title })).toBeVisible();
    await input.press('Escape');
    await expect(col.locator('.composer-input')).toHaveCount(0);
}

function watchErrors(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    return errors;
}

test('reads the project and creates a task via the assistant', async ({ page }) => {
    const pageErrors = watchErrors(page);
    await startProject(page);
    const mock = await mockGateway(page, [
        { prompt: 'How is this project set up?', tool: 'get_project_info', args: {}, answer: 'The project has three columns.' },
        { prompt: 'What is in the To do column?', tool: 'list_tasks', args: { column: 'To do' }, answer: 'No tasks in To do yet.' },
        {
            prompt: 'Create a task called Write launch notes',
            tool: 'create_task',
            args: {
                title: 'Write launch notes',
                description: 'Cover the release highlights',
                column: 'To do',
                priority: 'high',
                due_date: '2026-12-31',
            },
            answer: 'Created "Write launch notes" in To do.',
        },
    ]);
    const dialog = await openAssistant(page);

    await askAssistant(page, dialog, 'How is this project set up?');
    await expect(step(dialog, 'Read the project').locator('.pm-as-step-status')).toHaveText('Done');
    await expect(dialog.locator('.pm-as-answer').last()).toContainText('The project has three columns.');

    await askAssistant(page, dialog, 'What is in the To do column?');
    await expect(step(dialog, 'List tasks in To do').locator('.pm-as-step-status')).toHaveText('Done');
    await expect(dialog.locator('.pm-as-answer').last()).toContainText('No tasks in To do yet.');

    await askAssistant(page, dialog, 'Create a task called Write launch notes');
    await expect(step(dialog, 'Create "Write launch notes"').locator('.pm-as-step-status')).toHaveText('Done');
    const created = column(page, 'To do').locator('.card-title', { hasText: 'Write launch notes' });
    await expect(created).toBeVisible();
    const createdCard = card(page, 'Write launch notes');
    await expect(createdCard.locator('.prio-high')).toHaveCount(1);
    await expect(createdCard.locator('.due')).toHaveCount(1);

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog', { name: 'Project assistant' })).toHaveCount(0);
    await card(page, 'Write launch notes').click();
    const sheet = page.getByRole('dialog', { name: 'Task' });
    await expect(sheet.getByLabel('Task title')).toHaveValue('Write launch notes');
    await expect(sheet.locator('.desc-view')).toContainText('Cover the release highlights');
    await expect(sheet.getByLabel('Priority')).toHaveValue('high');
    await expect(sheet.getByLabel('Due date')).toHaveValue('2026-12-31');
    await page.getByRole('button', { name: 'Close' }).click();

    mock.expectConsumed();
    expect(pageErrors).toEqual([]);
});

test('updates a task, adds checklist items, and comments on it', async ({ page }) => {
    const pageErrors = watchErrors(page);
    await startProject(page);
    await addTask(page, 'To do', 'Write launch notes');
    const mock = await mockGateway(page, [
        {
            prompt: 'Change the notes task',
            tool: 'update_task',
            args: {
                task: 'Write launch notes',
                description: 'Updated scope for v2',
                priority: 'low',
                due_date: '2026-11-15',
            },
            answer: 'Updated "Write launch notes".',
        },
        {
            prompt: 'Break it into steps',
            tool: 'add_checklist_items',
            args: { task: 'Write launch notes', items: ['Draft outline', 'Collect screenshots'] },
            answer: 'Added two checklist items.',
        },
        {
            prompt: 'Leave a note on it',
            tool: 'add_comment',
            args: { task: 'Write launch notes', text: 'Waiting on design review.' },
            answer: 'Comment added.',
        },
    ]);
    const dialog = await openAssistant(page);

    await askAssistant(page, dialog, 'Change the notes task to updated scope for v2, low priority, due 2026-11-15');
    await expect(step(dialog, 'Update "Write launch notes"').locator('.pm-as-step-status')).toHaveText('Done');
    const editedCard = card(page, 'Write launch notes');
    await expect(editedCard.locator('.prio-low')).toHaveCount(1);
    await expect(editedCard.locator('.due')).toHaveCount(1);

    await askAssistant(page, dialog, 'Break it into steps');
    await expect(step(dialog, 'Add 2 checklist items to "Write launch notes"').locator('.pm-as-step-status')).toHaveText('Done');
    await expect(editedCard.locator('.card-count[title="Checklist: 0 of 2 done"]')).toHaveCount(1);

    await askAssistant(page, dialog, 'Leave a note on it');
    await expect(step(dialog, 'Comment on "Write launch notes"').locator('.pm-as-step-status')).toHaveText('Done');
    await expect(editedCard.locator('.card-count[title="1 comments"]')).toHaveCount(1);

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog', { name: 'Project assistant' })).toHaveCount(0);
    await card(page, 'Write launch notes').click();
    const sheet = page.getByRole('dialog', { name: 'Task' });
    await expect(sheet.locator('.desc-view')).toContainText('Updated scope for v2');
    await expect(sheet.getByLabel('Priority')).toHaveValue('low');
    await expect(sheet.getByLabel('Due date')).toHaveValue('2026-11-15');
    await expect(sheet.locator('.checklist-item')).toHaveCount(2);
    await expect(sheet.locator('.checklist-text').nth(0)).toHaveValue('Draft outline');
    await expect(sheet.locator('.checklist-text').nth(1)).toHaveValue('Collect screenshots');
    await expect(sheet.locator('.comment-text')).toContainText('Waiting on design review.');
    await page.getByRole('button', { name: 'Close' }).click();

    mock.expectConsumed();
    expect(pageErrors).toEqual([]);
});

test('moves a task to another column and creates a column', async ({ page }) => {
    const pageErrors = watchErrors(page);
    await startProject(page);
    await addTask(page, 'To do', 'Write launch notes');
    const mock = await mockGateway(page, [
        {
            prompt: 'Move the notes task to In progress',
            tool: 'move_task',
            args: { task: 'Write launch notes', column: 'In progress' },
            answer: 'Moved "Write launch notes" to In progress.',
        },
        {
            prompt: 'Add a Review column',
            tool: 'create_column',
            args: { name: 'Review' },
            answer: 'Added the column "Review".',
        },
    ]);
    const dialog = await openAssistant(page);

    await askAssistant(page, dialog, 'Move the notes task to In progress');
    await expect(step(dialog, 'Move "Write launch notes" to In progress').locator('.pm-as-step-status')).toHaveText('Done');
    await expect(column(page, 'In progress').locator('.card-title', { hasText: 'Write launch notes' })).toBeVisible();
    await expect(column(page, 'To do').locator('.card-title', { hasText: 'Write launch notes' })).toHaveCount(0);

    await askAssistant(page, dialog, 'Add a Review column');
    await expect(step(dialog, 'Add the column "Review"').locator('.pm-as-step-status')).toHaveText('Done');
    await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
    await expect(column(page, 'Review').locator('.card')).toHaveCount(0);

    mock.expectConsumed();
    expect(pageErrors).toEqual([]);
});

test('archives a task and deletes another after approval', async ({ page }) => {
    const pageErrors = watchErrors(page);
    await startProject(page);
    await addTask(page, 'To do', 'Archive me');
    await addTask(page, 'To do', 'Delete me');
    const mock = await mockGateway(page, [
        {
            prompt: 'Archive the Archive me task',
            tool: 'archive_task',
            args: { task: 'Archive me' },
            answer: 'Archived "Archive me".',
        },
        {
            prompt: 'Delete the Delete me task',
            tool: 'delete_task',
            args: { task: 'Delete me' },
            answer: 'Deleted "Delete me".',
        },
    ]);
    const dialog = await openAssistant(page);

    await askAssistant(page, dialog, 'Archive the Archive me task');
    await expect(step(dialog, 'Archive "Archive me"').locator('.pm-as-step-status')).toHaveText('Done');
    await expect(card(page, 'Archive me')).toHaveCount(0);
    await expect(card(page, 'Delete me')).toHaveCount(1);

    await askAssistant(page, dialog, 'Delete the Delete me task', { approve: true });
    await expect(step(dialog, 'Delete "Delete me"').locator('.pm-as-step-status')).toHaveText('Done');
    await expect(card(page, 'Delete me')).toHaveCount(0);

    const stored = await page.evaluate(() => {
        const id = location.hash.split('/')[2];
        const doc = window.__pm.store.getDoc(id);
        return {
            active: doc.tasks.map((task) => task.title),
            archived: doc.archive.map((task) => task.title),
            trashed: doc.trash.map((task) => task.title),
        };
    });
    expect(stored.active).not.toContain('Archive me');
    expect(stored.active).not.toContain('Delete me');
    expect(stored.archived).toContain('Archive me');
    expect(stored.trashed).toContain('Delete me');

    mock.expectConsumed();
    expect(pageErrors).toEqual([]);
});
