import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  bulkJournalPostExecuteSchema,
  bulkJournalPostPreviewSchema,
} from '../src/shared/validation.ts';

test('bulkJournalPostPreviewSchema validates SELECTED and ALL_DRAFTS payloads properly', () => {
  const emptySelected = bulkJournalPostPreviewSchema.safeParse({
    mode: 'SELECTED',
    entryIds: [],
  });
  assert.equal(emptySelected.success, false);

  const invalidUuid = bulkJournalPostPreviewSchema.safeParse({
    mode: 'SELECTED',
    entryIds: ['not-a-uuid'],
  });
  assert.equal(invalidUuid.success, false);

  const validSelected = bulkJournalPostPreviewSchema.safeParse({
    mode: 'SELECTED',
    entryIds: [crypto.randomUUID(), crypto.randomUUID()],
  });
  assert.equal(validSelected.success, true);

  const validAllDrafts = bulkJournalPostPreviewSchema.safeParse({
    mode: 'ALL_DRAFTS',
    filters: {
      search: 'مبيعات',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    },
  });
  assert.equal(validAllDrafts.success, true);
});

test('bulkJournalPostExecuteSchema enforces explicit confirmation and valid filter format', () => {
  const id1 = crypto.randomUUID();

  const missingConfirm = bulkJournalPostExecuteSchema.safeParse({
    mode: 'SELECTED',
    entryIds: [id1],
  });
  assert.equal(missingConfirm.success, false);

  const falseConfirm = bulkJournalPostExecuteSchema.safeParse({
    mode: 'ALL_DRAFTS',
    confirm: false,
  });
  assert.equal(falseConfirm.success, false);

  const badDateFilter = bulkJournalPostExecuteSchema.safeParse({
    mode: 'ALL_DRAFTS',
    confirm: true,
    filters: {
      startDate: '2026/01/01',
    },
  });
  assert.equal(badDateFilter.success, false);

  const validExecuteSelected = bulkJournalPostExecuteSchema.safeParse({
    mode: 'SELECTED',
    entryIds: [id1],
    confirm: true,
    stream: true,
  });
  assert.equal(validExecuteSelected.success, true);

  const validExecuteAllDrafts = bulkJournalPostExecuteSchema.safeParse({
    mode: 'ALL_DRAFTS',
    confirm: true,
    filters: { search: '', startDate: '', endDate: '' },
  });
  assert.equal(validExecuteAllDrafts.success, true);
});
