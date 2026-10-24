import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installPuterMock } from './helpers/puter-mock.js';
import { Store } from '../src/lib/store.js';
import { TOOLS, TOOL_NAMES, changesProject, describeCall, projectSnapshot, runTool } from '../src/lib/ai-tools.js';

let store, project;

beforeEach(async () => {
    vi.useFakeTimers();
    installPuterMock({ username: 'nadia' });
    store = new Store();
    await store.init();
    project = await store.createProject({ name: 'Release', color: '#4f63f0' });
});

const call = (name, args = {}) => runTool(store, project.id, name, args);
const doc = () => store.getDoc(project.id);

describe('project assistant tools', () => {
    it('offers the project surface and marks writes', () => {
        expect(TOOLS.length).toBe(10);
        expect([...TOOL_NAMES]).toContain('create_task');
        expect(changesProject('list_tasks')).toBe(false);
        expect(changesProject('create_task')).toBe(true);
        expect(describeCall(store, project.id, 'delete_task', { task: 'Ship' })).toMatchObject({ destructive: true });
    });

    it('reports the project and its tasks', () => {
        call('create_task', { title: 'Write the notes', priority: 'high', due_date: '2026-11-01' });
        const info = call('get_project_info');
        expect(info.ok).toBe(true);
        expect(info.content).toContain('Release');
        expect(info.content).toContain('To do (1)');
        const listed = call('list_tasks');
        expect(listed.content).toContain('Write the notes [To do] · high · due 2026-11-01');
        expect(call('list_tasks', { column: 'Done' }).content).toBe('No tasks match.');
    });

    it('creates a task in a named column with labels and members', () => {
        doc().labels.push({ id: 'label-1', name: 'Docs', color: '#888888' });
        const result = call('create_task', { title: 'Draft', column: 'In progress', labels: ['Docs'], assignees: ['nadia'] });
        expect(result.ok).toBe(true);
        const task = doc().tasks.find(t => t.title === 'Draft');
        expect(task.columnId).toBe(doc().columns[1].id);
        expect(task.labelIds).toEqual(['label-1']);
        expect(task.assigneeIds).toEqual([doc().members[0].id]);
    });

    it('updates and moves a task by its title', () => {
        call('create_task', { title: 'Ship it' });
        expect(call('update_task', { task: 'ship it', description: 'Cut the release', due_date: '2026-12-01' }).ok).toBe(true);
        const task = doc().tasks[0];
        expect(task.description).toBe('Cut the release');
        expect(task.dueDate).toBe('2026-12-01');
        expect(call('move_task', { task: 'Ship it', column: 'Done' }).ok).toBe(true);
        expect(task.columnId).toBe(doc().columns[2].id);
        expect(task.doneAt).toBeTruthy();
    });

    it('adds checklist items and comments', () => {
        call('create_task', { title: 'Ship it' });
        expect(call('add_checklist_items', { task: 'Ship it', items: ['Tag', 'Publish'] }).ok).toBe(true);
        expect(doc().tasks[0].checklist.map(i => i.text)).toEqual(['Tag', 'Publish']);
        expect(call('add_comment', { task: 'Ship it', text: 'Looks good' }).ok).toBe(true);
        expect(doc().tasks[0].comments[0].text).toBe('Looks good');
    });

    it('adds a column and archives and deletes tasks', () => {
        expect(call('create_column', { name: 'Review' }).ok).toBe(true);
        expect(doc().columns.at(-1).name).toBe('Review');
        call('create_task', { title: 'Old' });
        expect(call('archive_task', { task: 'Old' }).ok).toBe(true);
        expect(doc().tasks).toHaveLength(0);
        expect(doc().archive[0].title).toBe('Old');
        call('create_task', { title: 'Gone' });
        expect(call('delete_task', { task: 'Gone' }).ok).toBe(true);
        expect(doc().trash[0].title).toBe('Gone');
    });

    it('refuses ambiguous, unknown and invalid input', () => {
        call('create_task', { title: 'A report' });
        call('create_task', { title: 'A report draft' });
        expect(call('update_task', { task: 'report', description: 'x' })).toMatchObject({ ok: false });
        expect(call('move_task', { task: 'Nope', column: 'Done' })).toMatchObject({ ok: false });
        expect(call('create_task', { title: 'x', due_date: 'tomorrow' })).toMatchObject({ ok: false });
        expect(call('create_task', { title: 'x', column: 'Nowhere' })).toMatchObject({ ok: false });
        expect(call('no_such_tool')).toMatchObject({ ok: false });
    });

    it('puts today and the project shape in the snapshot', () => {
        const snapshot = projectSnapshot(store, project.id, { now: new Date('2026-10-24T12:00:00') });
        expect(snapshot).toContain('2026-10-24');
        expect(snapshot).toContain('Project "Release"');
        expect(snapshot).toContain('Columns: To do (0), In progress (0), Done (0)');
    });
});
