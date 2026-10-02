import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const keyValues = sqliteTable('key_values', {
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.key] })]);

export const projects = sqliteTable('projects', {
  scope: text('scope').notNull(),
  id: integer('id').notNull(),
  payload: text('payload').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.id] })]);

export const issues = sqliteTable('issues', {
  scope: text('scope').notNull(),
  id: integer('id').notNull(),
  projectId: integer('project_id').notNull(),
  statusId: integer('status_id').notNull(),
  fixedVersionId: integer('fixed_version_id'),
  updatedOn: text('updated_on').notNull(),
  payload: text('payload').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.id] })]);

export const versions = sqliteTable('versions', {
  scope: text('scope').notNull(),
  id: integer('id').notNull(),
  projectId: integer('project_id').notNull(),
  status: text('status').notNull(),
  payload: text('payload').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.id] })]);

export const journals = sqliteTable('journals', {
  scope: text('scope').notNull(),
  id: integer('id').notNull(),
  issueId: integer('issue_id').notNull(),
  createdOn: text('created_on').notNull(),
  payload: text('payload').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.id] })]);

export const issueRoles = sqliteTable('issue_roles', {
  scope: text('scope').notNull(),
  issueId: integer('issue_id').notNull(),
  developerId: integer('developer_id'),
  qaId: integer('qa_id'),
}, (table) => [primaryKey({ columns: [table.scope, table.issueId] })]);

export const peopleSelections = sqliteTable('people_selections', {
  scope: text('scope').notNull(),
  operationId: text('operation_id').notNull(),
  projectId: integer('project_id').notNull(),
  personId: integer('person_id').notNull(),
  field: text('field').notNull(),
  selectedOn: text('selected_on').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.operationId, table.field] })]);

export const drafts = sqliteTable('drafts', {
  scope: text('scope').notNull(),
  issueId: integer('issue_id').notNull(),
  payload: text('payload').notNull(),
  updatedOn: text('updated_on').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.issueId] })]);

export const notifications = sqliteTable('notifications', {
  scope: text('scope').notNull(),
  id: text('id').notNull(),
  projectId: integer('project_id').notNull(),
  issueId: integer('issue_id').notNull(),
  createdOn: text('created_on').notNull(),
  readAt: text('read_at'),
  payload: text('payload').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.id] })]);

export const sourceEvents = sqliteTable('source_events', {
  scope: text('scope').notNull(),
  id: text('id').notNull(),
  seenAt: text('seen_at').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.id] })]);

export const syncCursors = sqliteTable('sync_cursors', {
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  updatedOn: text('updated_on').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.key] })]);

export const operations = sqliteTable('operations', {
  scope: text('scope').notNull(),
  id: text('id').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  issueId: integer('issue_id'),
  versionId: integer('version_id'),
  createdOn: text('created_on').notNull(),
  updatedOn: text('updated_on').notNull(),
  payload: text('payload').notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.id] })]);
