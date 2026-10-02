CREATE TABLE `drafts` (
	`scope` text NOT NULL,
	`issue_id` integer NOT NULL,
	`payload` text NOT NULL,
	`updated_on` text NOT NULL,
	PRIMARY KEY(`scope`, `issue_id`)
);
--> statement-breakpoint
CREATE TABLE `issue_roles` (
	`scope` text NOT NULL,
	`issue_id` integer NOT NULL,
	`developer_id` integer,
	`qa_id` integer,
	PRIMARY KEY(`scope`, `issue_id`)
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`scope` text NOT NULL,
	`id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`status_id` integer NOT NULL,
	`fixed_version_id` integer,
	`updated_on` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `journals` (
	`scope` text NOT NULL,
	`id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`created_on` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `key_values` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`project_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`created_on` text NOT NULL,
	`read_at` text,
	`payload` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`issue_id` integer,
	`version_id` integer,
	`created_on` text NOT NULL,
	`updated_on` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`scope` text NOT NULL,
	`id` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `source_events` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`seen_at` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `sync_cursors` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_on` text NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `versions` (
	`scope` text NOT NULL,
	`id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
