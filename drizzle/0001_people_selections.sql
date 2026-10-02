CREATE TABLE `people_selections` (
	`scope` text NOT NULL,
	`operation_id` text NOT NULL,
	`project_id` integer NOT NULL,
	`person_id` integer NOT NULL,
	`field` text NOT NULL,
	`selected_on` text NOT NULL,
	PRIMARY KEY(`scope`, `operation_id`, `field`)
);
